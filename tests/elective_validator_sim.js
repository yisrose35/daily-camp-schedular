// =============================================================================
// elective_validator_sim.js
// -----------------------------------------------------------------------------
// The validators must SURFACE an elective facility violation: a bunk in a
// DIFFERENT division sitting on an elective's reserved facility during the
// elective's window. Electives create NO schedule entry (they render from the
// skeleton), so no prior check saw them — validator.js CHECK 16 and
// auto_validator section F rebuild the elective reservations from the skeleton
// (getFieldReservationsFromSkeleton) and flag foreign-grade placements on them.
//
// (A) SOURCE GUARDS — both validators define the check AND call it.
// (B) BEHAVIORAL — mirror the detection, driven by the REAL
//     getFieldReservationsFromSkeleton + a synthetic schedule.
// =============================================================================

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---- (A) SOURCE GUARDS -------------------------------------------------------
{
    const v = fs.readFileSync(path.join(__dirname, '..', 'validator.js'), 'utf8');
    assert.ok(/function checkElectiveReservations/.test(v), 'validator.js defines checkElectiveReservations');
    assert.ok(/checkElectiveReservations\(assignments, bunkDivMap, divisionTimes\)/.test(v),
        'validator.js calls checkElectiveReservations in validateSchedule');
    const a = fs.readFileSync(path.join(__dirname, '..', 'auto_validator.js'), 'utf8');
    assert.ok(/function checkElectiveReservations/.test(a), 'auto_validator.js defines checkElectiveReservations');
    assert.ok(/electiveErrors\.forEach/.test(a), 'auto_validator.js pushes elective errors into allErrors');
    // Phantom-reservation guard: a reserving division that wasn't generated today
    // (no live schedule) must be skipped in BOTH validators.
    assert.ok(/liveDivisions/.test(v) && /!liveDivisions\.has\(String\(r\.division\)\)/.test(v),
        'validator.js skips electives whose division has no live schedule today');
    assert.ok(/liveDivisions/.test(a) && /!liveDivisions\.has\(String\(r\.division\)\)/.test(a),
        'auto_validator.js skips electives whose division has no live schedule today');
    console.log('SOURCE GUARD PASS — both validators define + wire the elective check + phantom-division guard');
}

// ---- (B) BEHAVIORAL MIRROR ---------------------------------------------------
global.window = { addEventListener: () => {}, divisionTimes: {} };
global.document = { readyState: 'complete', addEventListener: () => {} };
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'scheduler_core_utils.js'), 'utf8'));
const Utils = global.window.SchedulerCoreUtils;

// Elective for מתמדים reserves Pizza Making + Gaming Center @ 5:10–6:00pm (1030–1080).
const resv = Utils.getFieldReservationsFromSkeleton([{
    type: 'elective', division: 'מתמדים', event: 'Elective',
    startTime: '5:10 PM', endTime: '6:00 PM',
    electiveActivities: ['Pizza Making', 'Gaming Center']
}]);

// Mirror of the validator's detection (elective-only, own-grade exempt,
// phantom-division guard). A reserving division with no live (non-empty)
// schedule today wasn't generated → its reservation is skipped.
function findElectiveViolations(assignments, bunkDiv, divTimes) {
    const keyLc = {};
    Object.keys(resv).forEach(k => {
        const list = (resv[k] || []).filter(r => r && (r.type === 'elective' || r.type === 'swim_elective'));
        if (list.length) keyLc[String(k).toLowerCase().trim()] = { key: k, list };
    });
    const liveDivisions = new Set();
    Object.keys(assignments).forEach(bunk => {
        const dv = bunkDiv[bunk];
        if (dv == null) return;
        if ((assignments[bunk] || []).some(e => e && !e.continuation && (e._activity || (e.field && e.field !== 'Free'))))
            liveDivisions.add(String(dv));
    });
    const out = [];
    Object.keys(assignments).forEach(bunk => {
        const div = bunkDiv[bunk];
        (assignments[bunk] || []).forEach((e, idx) => {
            if (!e || e._pinned || e.continuation) return;
            const act = e._activity || e.field;
            let sM = e._startMin, eM = e._endMin;
            if (sM == null) { const sl = (divTimes[div] || [])[idx]; if (sl) { sM = sl.startMin; eM = sl.endMin; } }
            if (sM == null) return;
            const cands = [e.field, e._location, act].filter(Boolean);
            for (const cf of cands) {
                const rec = keyLc[String(cf).toLowerCase().trim()];
                if (!rec) continue;
                for (const r of rec.list) {
                    if (!(r.startMin < eM && r.endMin > sM)) continue;
                    if (String(r.division) === String(div)) continue;          // own grade exempt
                    if (r.division && !liveDivisions.has(String(r.division))) continue; // phantom division
                    if (String(act).toLowerCase() === String(r.event).toLowerCase()) continue;
                    out.push({ bunk, div, act, field: rec.key });
                    return;
                }
            }
        });
    });
    return out;
}

const divTimes = {
    'Camp Agudah > 6': [ { startMin: 1030, endMin: 1110 } ],
    'מתמדים':          [ { startMin: 1030, endMin: 1080 } ],
    '7':               [ { startMin: 1200, endMin: 1260 } ],
};
const bunkDiv = { 'ח': 'Camp Agudah > 6', 'Masmidim': 'מתמדים', 'כ': '7' };

// TEST 1 — foreign grade on the elective facility IS flagged when the reserving
// division is LIVE today (its elective window renders empty, but it has other
// real entries, so it counts as generated).
{
    const assignments = {
        'ח':        [ { field: 'Pizza Making', _activity: 'Pizza Making', _startMin: 1030, _endMin: 1110 } ],
        'Masmidim': [ { field: 'Beis Medrash', _activity: 'Learning',     _startMin: 1200, _endMin: 1260 } ],
    };
    const v = findElectiveViolations(assignments, bunkDiv, divTimes);
    assert.strictEqual(v.length, 1, 'foreign-grade elective conflict flagged');
    assert.strictEqual(v[0].field, 'Pizza Making');
    console.log('TEST 1 PASS — foreign grade on a LIVE elective division is flagged');
}

// TEST 2 — the elective's OWN grade is NOT flagged.
{
    const assignments = { 'Masmidim': [ { field: 'Pizza Making', _activity: 'Pizza Making', _startMin: 1030, _endMin: 1080 } ] };
    assert.strictEqual(findElectiveViolations(assignments, bunkDiv, divTimes).length, 0, "own grade not flagged");
    console.log('TEST 2 PASS — own grade exempt');
}

// TEST 3 — disjoint time & unreserved facility are NOT flagged.
{
    const assignments = {
        'ח': [ { field: 'Pizza Making', _activity: 'Pizza Making', _startMin: 1090, _endMin: 1140 } ], // after window
        'כ': [ { field: 'Basketball', _activity: 'Basketball', _startMin: 1030, _endMin: 1110 } ],       // unrelated
    };
    assert.strictEqual(findElectiveViolations(assignments, bunkDiv, divTimes).length, 0, 'no false positives');
    console.log('TEST 3 PASS — disjoint time / unreserved facility not flagged');
}

// TEST 4 — PHANTOM DIVISION (the reported false positive): the reserving
// division (מתמדים) was NOT generated today — it has NO real entries anywhere,
// so its skeleton elective tile holds rooms nobody occupies. A foreign grade on
// those rooms must NOT be flagged.
{
    const assignments = {
        'ח':        [ { field: 'Pizza Making', _activity: 'Pizza Making', _startMin: 1030, _endMin: 1110 } ],
        'Masmidim': [],   // division present in roster but not generated → phantom
    };
    assert.strictEqual(findElectiveViolations(assignments, bunkDiv, divTimes).length, 0,
        'phantom (non-generated) elective division must not produce a conflict');
    console.log('TEST 4 PASS — phantom (non-generated) elective division not flagged');
}

console.log('\n✅ ALL elective_validator_sim TESTS PASSED');
