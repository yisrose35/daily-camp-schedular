// =============================================================================
// keep_in_use_idle_validator_sim.js
// -----------------------------------------------------------------------------
// Drives the REAL validator.js CHECK 18 (keep-in-use facility left idle).
//
// A facility flagged "Keep in use" should have somebody in it whenever the camp
// is running activities. With STAGGERED grade periods the generator cannot
// always reach every minute — e.g. Grade 1 runs 10-11/11-12 and Grade 2 runs
// 10:15-11:15/11:15-12:15, so no bunk's period starts at 12:00 and 12:00-12:30
// is unreachable. The user should SEE that rather than assume the gym is busy.
//
//   T1 fully covered            → no warning
//   T2 tail gap (the staggered case) → warned, with the right window
//   T3 gap in the MIDDLE        → warned
//   T4 lunch-only time          → NOT warned (nobody could have been sent there)
//   T5 facility's own Unavailable window → NOT warned (it's shut, not wasted)
//   T6 outside the configured "only between" window → NOT warned
//   T7 league game counts as occupancy → no warning
//   T8 facility not flagged     → no warning at all (exact no-op)
// =============================================================================

'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'validator.js'), 'utf8');

const GYM = (extra) => Object.assign(
    { name: 'New Gym', activities: ['Basketball'], available: true, keepInUse: { enabled: true } },
    extra || {}
);

function makeValidator(over) {
    const fields = over.fields || [GYM()];
    const w = {
        scheduleAssignments: over.assignments || {},
        divisions: over.divisions || {},
        divisionTimes: over.divisionTimes || {},
        leagueAssignments: over.leagueAssignments || {},
        loadGlobalSettings: () => ({ app1: { fields: fields } }),
        getAllSpecialActivities: () => [],
        getDivisionAgeOrder: (n) => n || [],
        currentScheduleDate: '2026-07-24',
        // The real helper — single source of truth for the flag.
        SchedulerCoreUtils: {
            getKeepInUseFields() {
                return fields.filter(f => f && f.keepInUse && f.keepInUse.enabled === true
                        && f.available !== false && (f.activities || []).length)
                    .map(f => ({
                        name: f.name, activities: f.activities,
                        startMin: f.keepInUse.startMin != null ? f.keepInUse.startMin : null,
                        endMin: f.keepInUse.endMin != null ? f.keepInUse.endMin : null,
                        rotateGrades: f.keepInUse.rotateGrades !== false,
                        fieldObj: f
                    }));
            }
        },
    };
    const doc = {
        getElementById: () => ({}), createElement: () => ({ style: {} }),
        head: { appendChild() {} }, body: { appendChild() {} },
        addEventListener() {}, removeEventListener() {},
    };
    new Function('window', 'document', src)(w, doc);
    return { w, v: w.ScheduleValidator._v31 };
}

const bunkDivMapOf = (divisions) => {
    const m = {};
    Object.entries(divisions).forEach(([d, dd]) => (dd.bunks || []).forEach(b => { m[String(b)] = d; }));
    return m;
};

function run(over) {
    const { w, v } = makeValidator(over);
    const divisions = over.divisions || {};
    const bdm = bunkDivMapOf(divisions);
    const usages = v.collectTimedUsages(over.assignments || {}, divisions, over.divisionTimes || {}, bdm);
    return v.checkKeepInUseIdle(usages, over.assignments || {}, bdm, over.divisionTimes || {});
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
};

const gym = (s, e) => ({ field: 'New Gym', sport: 'Basketball', _activity: 'Basketball', _startMin: s, _endMin: e });
const soccer = (s, e) => ({ field: 'Soccer Field', sport: 'Soccer', _activity: 'Soccer', _startMin: s, _endMin: e });
const lunchAt = (s, e) => ({ field: 'Lunch', sport: null, _activity: 'Lunch', _startMin: s, _endMin: e });

// ---------------------------------------------------------------- T1
{
    const divisions = { 'Grade 1': { bunks: ['1A', '1B'] } };
    const divisionTimes = { 'Grade 1': [{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }] };
    const assignments = { '1A': [gym(600, 660), soccer(660, 720)], '1B': [soccer(600, 660), gym(660, 720)] };
    const ws = run({ divisions, divisionTimes, assignments });
    check('T1 fully covered → no warning', ws.length === 0, JSON.stringify(ws));
}

// ---------------------------------------------------------------- T2
{
    // The staggered case measured in the sweep: gym busy 600-720, camp runs to 750.
    const divisions = { 'Grade 1': { bunks: ['1A'] }, 'Grade 3': { bunks: ['3A'] } };
    const divisionTimes = {
        'Grade 1': [{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }],
        'Grade 3': [{ startMin: 630, endMin: 690 }, { startMin: 690, endMin: 750 }],
    };
    const assignments = {
        '1A': [gym(600, 660), gym(660, 720)],
        '3A': [soccer(630, 690), soccer(690, 750)],
    };
    const ws = run({ divisions, divisionTimes, assignments });
    check('T2 tail gap warned', ws.length === 1 && /New Gym/.test(ws[0]) && /Idle facility/.test(ws[0]), JSON.stringify(ws));
    check('T2 warning names the right window (12:00-12:30)', ws.length === 1 && /12:00/.test(ws[0]) && /12:30/.test(ws[0]), JSON.stringify(ws));
}

// ---------------------------------------------------------------- T3
{
    const divisions = { 'Grade 1': { bunks: ['1A'] } };
    const divisionTimes = { 'Grade 1': [{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }, { startMin: 720, endMin: 780 }] };
    const assignments = { '1A': [gym(600, 660), soccer(660, 720), gym(720, 780)] };
    const ws = run({ divisions, divisionTimes, assignments });
    check('T3 middle gap warned once', ws.length === 1 && /11:00/.test(ws[0]) && /12:00/.test(ws[0]), JSON.stringify(ws));
}

// ---------------------------------------------------------------- T4
{
    const divisions = { 'Grade 1': { bunks: ['1A'] } };
    const divisionTimes = { 'Grade 1': [{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }] };
    const assignments = { '1A': [gym(600, 660), lunchAt(660, 720)] };
    const ws = run({ divisions, divisionTimes, assignments });
    check('T4 lunch time is not "idle" — nobody could have gone', ws.length === 0, JSON.stringify(ws));
}

// ---------------------------------------------------------------- T5
{
    const divisions = { 'Grade 1': { bunks: ['1A'] } };
    const divisionTimes = { 'Grade 1': [{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }] };
    const assignments = { '1A': [gym(600, 660), soccer(660, 720)] };
    const ws = run({
        divisions, divisionTimes, assignments,
        fields: [GYM({ timeRules: [{ type: 'Unavailable', startMin: 660, endMin: 720 }] })],
    });
    check('T5 facility closed by its own time rule → not reported as wasted', ws.length === 0, JSON.stringify(ws));
}

// ---------------------------------------------------------------- T6
{
    const divisions = { 'Grade 1': { bunks: ['1A'] } };
    const divisionTimes = { 'Grade 1': [{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }] };
    const assignments = { '1A': [gym(600, 660), soccer(660, 720)] };
    const ws = run({
        divisions, divisionTimes, assignments,
        fields: [GYM({ keepInUse: { enabled: true, startMin: 600, endMin: 660 } })],
    });
    check('T6 outside the configured window → no warning', ws.length === 0, JSON.stringify(ws));
}

// ---------------------------------------------------------------- T7
{
    // The gym is held by a LEAGUE game — collectTimedUsages reads those from
    // leagueAssignments, not the bunk grid, so this proves the check sees them.
    const divisions = { 'Grade 1': { bunks: ['1A'] } };
    const divisionTimes = { 'Grade 1': [{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }] };
    const assignments = { '1A': [soccer(600, 660), gym(660, 720)] };
    const leagueAssignments = {
        'Grade 1': { 0: { matchups: ['T1 vs T2 @ New Gym (Basketball)'], gameLabel: 'Game 1', leagueName: 'G1' } },
    };
    const ws = run({ divisions, divisionTimes, assignments, leagueAssignments });
    check('T7 a league game counts as somebody being in there', ws.length === 0, JSON.stringify(ws));
}

// ---------------------------------------------------------------- T8
{
    const divisions = { 'Grade 1': { bunks: ['1A'] } };
    const divisionTimes = { 'Grade 1': [{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }] };
    const assignments = { '1A': [soccer(600, 660), soccer(660, 720)] };
    const ws = run({
        divisions, divisionTimes, assignments,
        fields: [{ name: 'New Gym', activities: ['Basketball'], available: true }],   // flag OFF
    });
    check('T8 facility not flagged → exact no-op', ws.length === 0, JSON.stringify(ws));
}

console.log('\n' + (fail === 0 ? '🎉' : '💥') + ' keep_in_use_idle_validator_sim: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
