// =========================================================================
// regen_span_glue_scope_sim.js — partial-regen scope vs multi-slot fills
//
// Loads the REAL division_times_system.js and drives buildTimeRegenScope with
// schedule entries shaped EXACTLY as fillBlock writes them:
//   • a multi-slot fill's continuation slots all carry the BLOCK's _startMin
//     (lead and continuation share one start time), and
//   • travel transition glue carries NO _startMin at all (only _isTransition /
//     _transitionType / _endTime).
//
// Live incident (2026-07): a custom pinned tile with reserved fields was
// edited (field switched), then a partial regen of tiles was run — and tiles
// at OTHER times of the day changed. Root cause: the per-entry re-key in
// buildTimeRegenScope treated the shared-start continuation as "two entries,
// one slot" and the unstamped travel glue as "un-addressable", so the bunk
// silently fell back to a FULL day re-roll. These tests pin the group-aware
// re-key that fixes it.
// Run: node tests/regen_span_glue_scope_sim.js
// =========================================================================
'use strict';
const fs = require('fs');
const path = require('path');

global.window = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} };
global.document = { addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [] };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.window.localStorage = global.localStorage;
global.window.CampUtils = {
    minutesToTimeLabel: (m) => {
        const h = Math.floor(m / 60), mm = m % 60, h12 = h % 12 || 12;
        return h12 + ':' + (mm < 10 ? '0' + mm : mm) + (h >= 12 ? 'pm' : 'am');
    }
};
eval(fs.readFileSync(path.join(__dirname, '..', 'division_times_system.js'), 'utf8'));
const DTS = global.window.DivisionTimesSystem;

let pass = true;
function ok(c, m) { if (!c) { pass = false; console.error('FAIL:', m); } else console.log('ok:', m); }

// ---- camp shape ---------------------------------------------------------
// Custom pinned tile 10:30-12:00 (reserved fields) overlaps a 10:30-11:15
// slot tile, so the boundary-union grid slices the day into 4 slots:
//   0: 600-630   1: 630-675   2: 675-720   3: 720-780
const divisions = { A: { bunks: ['B1', 'B2', 'B3'], startTime: '10:00am', endTime: '1:00pm' } };
const skeleton = [
    { id: 't1', division: 'A', startTime: '10:00am', endTime: '10:30am', event: 'Sports Slot', type: 'slot' },
    { id: 'p1', division: 'A', startTime: '10:30am', endTime: '12:00pm', event: 'Special Trip', type: 'pinned', reservedFields: ['Field 2'] },
    { id: 't2', division: 'A', startTime: '10:30am', endTime: '11:15am', event: 'GA Slot', type: 'slot' },
    { id: 't3', division: 'A', startTime: '12:00pm', endTime: '1:00pm', event: 'Sports Slot', type: 'slot' }
];

// Entries exactly as fillBlock stamps them.
// B1: the pinned fill spans slots 1+2 — continuation carries the SAME
//     _startMin/_endMin as the lead (both 630-720).
// B2: the pinned tile's reserved field has 45-min travel, so slot 1 holds
//     travel glue (NO _startMin) and the main fill sits in slot 2, still
//     stamped with the TILE's window 630-720.
// B3: post-travel variant — main fill in slot 1, glue in slot 2.
const mkSA = () => ({
    B1: [
        { _activity: 'Tennis', field: 'Tennis Court', _startMin: 600, _endMin: 630 },
        { _activity: 'Special Trip', field: 'Special Trip', _pinned: true, _startMin: 630, _endMin: 720, _reservedFields: ['Field 1'] },
        { _activity: 'Special Trip', field: 'Special Trip', _pinned: true, continuation: true, _startMin: 630, _endMin: 720 },
        { _activity: 'Soccer', field: 'Soccer Field', _startMin: 720, _endMin: 780 }
    ],
    B2: [
        { _activity: 'Hockey', field: 'Rink', _startMin: 600, _endMin: 630 },
        { field: 'Transition', sport: 'Travel', _isTransition: true, _transitionType: 'Pre', _zone: 'z', _endTime: 675, _fixed: true, _activity: 'Transition' },
        { _activity: 'Special Trip', field: 'Special Trip', _pinned: true, _startMin: 630, _endMin: 720 },
        { _activity: 'Baseball', field: 'Diamond', _startMin: 720, _endMin: 780 }
    ],
    B3: [
        { _activity: 'Hockey', field: 'Rink', _startMin: 600, _endMin: 630 },
        { _activity: 'Special Trip', field: 'Special Trip', _pinned: true, _startMin: 630, _endMin: 720 },
        { field: 'Transition', sport: 'Travel', _isTransition: true, _transitionType: 'Post', _zone: 'z', _endTime: 720, _fixed: true, _activity: 'Transition' },
        { _activity: 'Baseball', field: 'Diamond', _startMin: 720, _endMin: 780 }
    ]
});

// ---- 1. selecting an UNRELATED tile must not touch the rest of the day --
{
    const selections = ['B1', 'B2', 'B3'].map(b => ({ bunk: b, startMin: 600, endMin: 630 }));
    const scope = DTS.buildTimeRegenScope({ selections, skeleton, divisions, scheduleAssignments: mkSA(), leagueAssignments: {} });
    ok(scope.ok === true, 'scope builds');
    ok(scope.fullRerollBunks.length === 0, 'NO bunk falls back to a full day re-roll (was: all of them)');
    const b1 = scope.regenScope['B1'];
    ok(b1 && b1.regen.size === 1 && b1.regen.has(0), 'B1: only the selected 10:00 slot re-rolls');
    ok(b1 && b1.keep[1] && b1.keep[2] && b1.keep[2].continuation === true && b1.keep[3],
        'B1: pinned span (lead + continuation) and the 12:00 slot are all KEPT at their own indices');
    const b2 = scope.regenScope['B2'];
    ok(b2 && b2.regen.size === 1 && b2.regen.has(0), 'B2: only the selected slot re-rolls');
    ok(b2 && b2.keep[1] && b2.keep[1]._isTransition === true && b2.keep[2] && b2.keep[2]._activity === 'Special Trip',
        'B2: pre-travel glue kept in slot 1, trip kept in slot 2');
    const b3 = scope.regenScope['B3'];
    ok(b3 && b3.keep[1] && b3.keep[1]._activity === 'Special Trip' && b3.keep[2] && b3.keep[2]._isTransition === true,
        'B3: trip kept in slot 1, post-travel glue kept in slot 2');
}

// ---- 2. selecting the PINNED tile regenerates its WHOLE window ----------
{
    const selections = [{ bunk: 'B1', startMin: 630, endMin: 720 }, { bunk: 'B2', startMin: 630, endMin: 720 }];
    const scope = DTS.buildTimeRegenScope({ selections, skeleton, divisions, scheduleAssignments: mkSA(), leagueAssignments: {} });
    ok(scope.ok === true && scope.fullRerollBunks.length === 0, 'pinned-tile selection: no full re-roll');
    const b1 = scope.regenScope['B1'];
    ok(b1 && b1.regen.has(1) && b1.regen.has(2) && !b1.regen.has(0) && !b1.regen.has(3),
        'B1: BOTH sub-slots of the tile window re-roll, neighbors kept');
    ok(b1 && b1.orig[1] && b1.orig[2] && b1.keep[0] && b1.keep[3],
        'B1: originals captured for the re-rolled span; neighbors kept');
    const b2 = scope.regenScope['B2'];
    ok(b2 && b2.regen.has(1) && b2.regen.has(2),
        'B2: travel glue re-rolls WITH its fill (no stale travel left behind)');
}

// ---- 3. selecting a slot covered by a span drags the whole span in ------
{
    // select only the 10:30-11:15 GA sub-slot (inside the trip's window)
    const selections = [{ bunk: 'B1', startMin: 630, endMin: 675 }];
    const scope = DTS.buildTimeRegenScope({ selections, skeleton, divisions, scheduleAssignments: mkSA(), leagueAssignments: {} });
    ok(scope.ok === true, 'sub-slot selection builds');
    const b1 = scope.regenScope['B1'];
    ok(b1 && b1.regen.has(1) && b1.regen.has(2),
        'span integrity: selecting one sub-slot of a spanned fill regenerates the whole span');
    ok(b1 && b1.keep[0] && b1.keep[3], 'neighbors still kept');
}

// ---- 3b. kept pinned entries pick up the skeleton's CURRENT fields ------
// The user switched the pin's reserved field (skeleton says Field 2, entries
// still stamped Field 1), then regenerated a DIFFERENT tile. The kept pin
// must advertise the NEW field — the availability report reads reservations
// off the entry's _reservedFields.
{
    const selections = [{ bunk: 'B1', startMin: 600, endMin: 630 }];
    const scope = DTS.buildTimeRegenScope({ selections, skeleton, divisions, scheduleAssignments: mkSA(), leagueAssignments: {} });
    const b1 = scope.regenScope['B1'];
    ok(b1 && b1.keep[1] && Array.isArray(b1.keep[1]._reservedFields)
        && b1.keep[1]._reservedFields.join(',') === 'Field 2',
        'kept pinned entry re-stamped with the skeleton\'s CURRENT reservedFields (Field 1 → Field 2)');
    ok(b1 && b1.keep[0] === undefined || !b1.keep[0], 'selected slot not in keep');
    ok(b1 && b1.keep[3] && !b1.keep[3]._reservedFields, 'non-pinned kept entries untouched');
}

// ---- 4. safety fallbacks preserved --------------------------------------
{
    // orphan continuation (no adjacent lead) → full re-roll, never a partial shift
    const sa = mkSA();
    sa.B1[2] = { _activity: 'Ghost', continuation: true, _startMin: 630, _endMin: 720 };
    sa.B1[1] = null;
    const scope = DTS.buildTimeRegenScope({
        selections: [{ bunk: 'B1', startMin: 600, endMin: 630 }],
        skeleton, divisions, scheduleAssignments: sa, leagueAssignments: {}
    });
    ok(scope.ok === true && scope.fullRerollBunks.indexOf('B1') >= 0,
        'orphan continuation → B1 still falls back to a full re-roll');
}
{
    // un-addressable non-glue entry → full re-roll (legacy behavior)
    const sa = mkSA();
    sa.B2[0] = { _activity: 'Mystery' };
    const scope = DTS.buildTimeRegenScope({
        selections: [{ bunk: 'B2', startMin: 600, endMin: 630 }],
        skeleton, divisions, scheduleAssignments: sa, leagueAssignments: {}
    });
    ok(scope.ok === true && scope.fullRerollBunks.indexOf('B2') >= 0,
        'unstamped non-transition entry → full re-roll preserved');
}
{
    // the spanned tile was REMOVED from the skeleton → its entries drop cleanly
    const skel2 = skeleton.filter(t => t.id !== 'p1' && t.id !== 't2');
    const scope = DTS.buildTimeRegenScope({
        selections: [{ bunk: 'B1', startMin: 600, endMin: 630 }],
        skeleton: skel2, divisions, scheduleAssignments: mkSA(), leagueAssignments: {}
    });
    ok(scope.ok === true && scope.fullRerollBunks.length === 0, 'removed tile: no full re-roll');
    ok(scope.droppedEntries >= 2, 'removed tile: span entries dropped (period no longer exists)');
}

console.log(pass ? '\nALL PASS ✅' : '\nFAILURES ❌');
process.exit(pass ? 0 : 1);
