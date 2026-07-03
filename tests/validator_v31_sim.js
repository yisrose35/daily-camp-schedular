// validator_v31_sim.js
// Drives the REAL validator.js v3.1 checks (loaded via new Function with a
// stubbed window/document) against fixtures modeled on the live camp:
//   9  special access violations (grade/bunk gate)
//   10 disabled (turned-OFF) specials & fields placed anyway
//   11 per-date bunk-only access rules
//   12 league/event-aware facility conflicts (the leagueAssignments blind spot;
//      pin-vs-pin exempt, pure bunk-vs-bunk left to CHECK 1)
//   13 field-quality audit (missed upgrades with special-host / OFF / access /
//      time-rule / occupancy exclusions + bunk seniority inversions)
//
// Run: node tests/validator_v31_sim.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'validator.js'), 'utf8');

function makeValidator(over = {}) {
    const w = {
        scheduleAssignments: over.assignments || {},
        divisions: over.divisions || {},
        divisionTimes: over.divisionTimes || {},
        leagueAssignments: over.leagueAssignments || {},
        loadGlobalSettings: () => ({ app1: { fields: over.fields || [], specialActivities: over.specials || [] } }),
        getAllSpecialActivities: () => over.specials || [],
        getDivisionAgeOrder: (names) => over.order || names || [],
        getLocationForActivity: over.getLocationForActivity,
        isSpecialAvailableForBunk: over.isSpecialAvailableForBunk,
        loadCurrentDailyData: over.loadCurrentDailyData,
        SchedulerCoreUtils: over.SchedulerCoreUtils || {},
        FieldCombos: over.FieldCombos || null,
        currentScheduleDate: '2026-07-07',
    };
    const doc = {
        getElementById: () => ({}),           // truthy → style injection skipped
        createElement: () => ({ style: {} }),
        head: { appendChild() {} },
        body: { appendChild() {} },
        addEventListener() {},
        removeEventListener() {},
    };
    new Function('window', 'document', src)(w, doc);
    if (!w.ScheduleValidator || !w.ScheduleValidator._v31) throw new Error('v3.1 exports missing');
    return { w, v: w.ScheduleValidator._v31 };
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const bunkDivMapOf = (divisions) => {
    const m = {};
    Object.entries(divisions).forEach(([d, dd]) => (dd.bunks || []).forEach(b => { m[String(b)] = d; }));
    return m;
};

// ---------------------------------------------------------------- CHECK 9
{
    const divisions = { A: { bunks: ['b1'] }, B: { bunks: ['b2'] } };
    const specials = [{ name: 'Lake' }];
    const assignments = {
        b1: [{ _activity: 'Lake', field: 'Lake', _startMin: 600, _endMin: 660 }],
        b2: [{ _activity: 'Lake', field: 'Lake', _startMin: 700, _endMin: 760 }],
    };
    const { v } = makeValidator({
        divisions, specials, assignments,
        isSpecialAvailableForBunk: (n, d, b) => !(n === 'Lake' && b === 'b1'),
    });
    const errs = v.checkSpecialAccess(assignments, bunkDivMapOf(divisions), {});
    check('T9  disallowed special placement flagged, allowed one passes',
        errs.length === 1 && errs[0].includes('b1') && errs[0].includes('Lake'), JSON.stringify(errs));
}

// ---------------------------------------------------------------- CHECK 10
{
    const divisions = { A: { bunks: ['b1'] } };
    const specials = [{ name: 'Basketball Clinic', available: false }, { name: 'Lake' }];
    const fields = [{ name: 'Max Field 1', available: false }, { name: 'Court 1' }];
    const assignments = {
        b1: [
            { _activity: 'Basketball Clinic', _startMin: 600, _endMin: 660 },
            { _activity: 'Football', field: 'Max Field 1', _startMin: 700, _endMin: 760 },
            { _activity: 'Basketball', field: 'Court 1', _startMin: 800, _endMin: 860 },
        ],
    };
    const { v } = makeValidator({ divisions, specials, fields, assignments });
    const errs = v.checkDisabledResources(assignments, bunkDivMapOf(divisions), {});
    check('T10 OFF special + OFF field both flagged, ON field passes',
        errs.length === 2 && errs.some(e => e.includes('Basketball Clinic')) && errs.some(e => e.includes('Max Field 1')),
        JSON.stringify(errs));
}

// ---------------------------------------------------------------- CHECK 11
{
    const divisions = { A: { bunks: ['b1', 'b2'] } };
    const specials = [{ name: 'Lake' }];
    const assignments = {
        b1: [
            { _activity: 'Basketball', field: 'Gym', _startMin: 600, _endMin: 660 },
            { _activity: 'Lake', field: 'Lake', _startMin: 700, _endMin: 760 }, // special → CHECK 9 territory
        ],
        b2: [{ _activity: 'Basketball', field: 'Gym', _startMin: 600, _endMin: 660 }],
    };
    const { v } = makeValidator({
        divisions, specials, assignments,
        loadCurrentDailyData: () => ({ dailyActivityBunkRestrictions: [{ facility: 'Gym', activity: '*', bunks: ['b2'] }] }),
        SchedulerCoreUtils: {
            isBunkRestrictedFromTarget: (b, a, f) => String(f || '').toLowerCase() === 'gym' && b === 'b1',
        },
    });
    const errs = v.checkBunkOnlyAccess(assignments, bunkDivMapOf(divisions), {});
    check('T11 bunk-only rule: blocked bunk flagged once, allowed bunk + special skipped',
        errs.length === 1 && errs[0].includes('b1') && errs[0].includes('Gym'), JSON.stringify(errs));
}

// ------------------------------------------------- CHECK 12 (league/event)
{
    const divisions = { A: { bunks: ['a1'] }, B: { bunks: ['b9', 'b10'] }, C: { bunks: ['c1', 'c2'] } };
    const fields = [{ name: 'Court' }, { name: 'Field Z' }];
    const divisionTimes = { A: [{ startMin: 100, endMin: 160 }], B: [], C: [] };
    const assignments = {
        // league-vs-bunk on Court (the documented blind spot)
        b9: [{ _activity: 'Basketball', field: 'Court', _startMin: 120, _endMin: 180 }],
        // pin-vs-pin on Field Z (by design → exempt)
        b10: [{ _activity: 'Event One', field: 'Event One', _reservedFields: ['Field Z'], _startMin: 100, _endMin: 160 }],
        c1: [{ _activity: 'Event Two', field: 'Event Two', _reservedFields: ['Field Z'], _startMin: 120, _endMin: 180 }],
        c2: [{ _activity: 'Event Two', field: 'Event Two', _reservedFields: ['Field Z'], _startMin: 120, _endMin: 180 }],
    };
    const leagueAssignments = { A: { 0: { leagueName: 'Test League', matchups: ['1 vs 2 @ Court (Basketball)'] } } };
    const { v } = makeValidator({ divisions, fields, assignments, divisionTimes, leagueAssignments });
    const usages = v.collectTimedUsages(assignments, divisions, divisionTimes, bunkDivMapOf(divisions));
    const errs = v.checkLeagueFieldConflicts(usages);
    check('T12a league-vs-bunk double-book flagged',
        errs.length === 1 && errs[0].includes('Court') && errs[0].includes('Test League'), JSON.stringify(errs));
    check('T12b pin-vs-pin overlap exempt (by design)',
        !errs.some(e => e.includes('Field Z')));
    check('T12c whole-division pin deduped to one event usage per division',
        usages.filter(u => u.fkey === 'field z' && u.divName === 'C').length === 1,
        JSON.stringify(usages.filter(u => u.fkey === 'field z')));

    // pure bunk-vs-bunk left to CHECK 1
    const assignments2 = {
        b9: [{ _activity: 'Basketball', field: 'Court', _startMin: 100, _endMin: 160 }],
        c1: [{ _activity: 'Basketball', field: 'Court', _startMin: 120, _endMin: 180 }],
    };
    const { v: v2 } = makeValidator({ divisions, fields, assignments: assignments2 });
    const errs2 = v2.checkLeagueFieldConflicts(v2.collectTimedUsages(assignments2, divisions, {}, bunkDivMapOf(divisions)));
    check('T12d pure bunk-vs-bunk group skipped (CHECK 1 territory)', errs2.length === 0, JSON.stringify(errs2));
}

// ------------------------------------------------- CHECK 13 (field quality)
{
    const divisions = { A: { bunks: ['a1'] }, B: { bunks: ['b1'] } };
    const baseFields = () => ([
        { name: 'C1', fieldGroup: 'Basketball', qualityRank: 1 },
        { name: 'C2', fieldGroup: 'Basketball', qualityRank: 2 },
    ]);
    const mkUsage = (over = {}) => Object.assign(
        { fkey: 'c2', facility: 'C2', divName: 'A', bunk: 'a1', owner: 'Bunk a1', kind: 'bunk', startMin: 600, endMin: 660, activity: 'Basketball' },
        over);

    // T13a: better field genuinely free → warning
    {
        const { v } = makeValidator({ divisions, fields: baseFields() });
        const warns = v.checkFieldQuality([mkUsage()]);
        check('T13a missed upgrade flagged (better field free+ON+usable)',
            warns.length === 1 && warns[0].includes('C1'), JSON.stringify(warns));
    }
    // T13b: better field turned OFF → silent
    {
        const fields = baseFields(); fields[0].available = false;
        const { v } = makeValidator({ divisions, fields });
        check('T13b OFF better field not a miss', v.checkFieldQuality([mkUsage()]).length === 0);
    }
    // T13c: better field hosts a special → silent (the Jump Shot case)
    {
        const { v } = makeValidator({
            divisions, fields: baseFields(),
            specials: [{ name: 'VR' }],
            getLocationForActivity: (n) => (n === 'VR' ? 'C1' : null),
        });
        check('T13c special-host better field not a miss', v.checkFieldQuality([mkUsage()]).length === 0);
    }
    // T13d: better field occupied by a league → silent
    {
        const { v } = makeValidator({ divisions, fields: baseFields() });
        const league = mkUsage({ fkey: 'c1', facility: 'C1', divName: 'B', owner: 'League "X" — 1 vs 2', kind: 'league' });
        check('T13d league-occupied better field not a miss', v.checkFieldQuality([mkUsage(), league]).length === 0);
    }
    // T13e: access-restricted better field → silent
    {
        const fields = baseFields();
        fields[0].accessRestrictions = { enabled: true, divisions: { OtherDiv: [] } };
        const { v } = makeValidator({ divisions, fields });
        check('T13e access-restricted better field not a miss', v.checkFieldQuality([mkUsage()]).length === 0);
    }
    // T13f: time-rule-closed better field → silent
    {
        const fields = baseFields();
        fields[0].timeRules = [{ type: 'unavailable', startMin: 500, endMin: 700 }];
        const { v } = makeValidator({ divisions, fields });
        check('T13f time-rule-closed better field not a miss', v.checkFieldQuality([mkUsage()]).length === 0);
    }
    // T13i: preference-EXCLUSIVE better field (division not on the list) → silent;
    //        division ON the list still gets the miss (the New Gym 2 case)
    {
        const fields = baseFields();
        fields[0].preferences = { enabled: true, exclusive: true, list: ['B'] };
        const { v } = makeValidator({ divisions, fields });
        check('T13i pref-exclusive better field not a miss for excluded division',
            v.checkFieldQuality([mkUsage()]).length === 0);
        const { v: v2 } = makeValidator({ divisions, fields });
        check('T13i2 pref-exclusive better field IS a miss for an included division',
            v2.checkFieldQuality([mkUsage({ divName: 'B', bunk: 'b1', owner: 'Bunk b1' })]).length === 1);
    }
    // T13j: combined field — counterpart in use consumes the candidate (New Gym Full)
    {
        const FieldCombos = {
            isInCombo: (k) => k === 'c1',
            getExclusiveFields: (k) => (k === 'c1' ? ['Full Court'] : []),
        };
        const { v } = makeValidator({ divisions, fields: baseFields(), FieldCombos });
        const fullBusy = mkUsage({ fkey: 'full court', facility: 'Full Court', divName: 'B', owner: 'B — Event', kind: 'event' });
        check('T13j combo counterpart busy → candidate not a miss',
            v.checkFieldQuality([mkUsage(), fullBusy]).length === 0);
        const { v: v2 } = makeValidator({ divisions, fields: baseFields(), FieldCombos });
        check('T13j2 combo counterpart free → miss still flagged',
            v2.checkFieldQuality([mkUsage()]).length === 1);
    }
    // T13g: seniority inversion among bunks → warning; league holder → none
    {
        const { v } = makeValidator({ divisions, fields: baseFields(), order: ['A', 'B'] });
        const seniorWorse = mkUsage(); // senior A on #2
        const juniorBetter = mkUsage({ fkey: 'c1', facility: 'C1', divName: 'B', bunk: 'b1', owner: 'Bunk b1' });
        const warns = v.checkFieldQuality([seniorWorse, juniorBetter]);
        check('T13g junior bunk on better field than senior flagged as inversion',
            warns.some(w => w.includes('seniority inversion')), JSON.stringify(warns));
        const leagueHolder = mkUsage({ fkey: 'c1', facility: 'C1', divName: 'B', owner: 'League "X" — 1 vs 2', kind: 'league' });
        const warns2 = v.checkFieldQuality([seniorWorse, leagueHolder]);
        check('T13h junior LEAGUE holding better field NOT an inversion (league priority by design)',
            !warns2.some(w => w.includes('seniority inversion')), JSON.stringify(warns2));
    }
}

// -------------------------------------- v3.1.1: pinned events ≠ fields
// (live false positives: "Showers lekoved shabbos kodesh not sharable but
//  used by 14 bunks", "avl used by 12 bunks (Max Capacity: 1)")
{
    const divisions = { A: { bunks: ['a1', 'a2'] }, B: { bunks: ['b1'] }, C: { bunks: ['c1'] } };
    const fields = [{ name: 'Court X' }]; // Court X defaults to not_sharable
    const divisionTimes = {
        A: [{ startMin: 1020, endMin: 1080 }],
        B: [{ startMin: 1020, endMin: 1080 }],
        C: [{ startMin: 1020, endMin: 1080 }],
    };
    const bdm = bunkDivMapOf(divisions);
    const mk = (over) => Object.assign({ _startMin: 1020, _endMin: 1080 }, over);

    // T14a: whole-camp custom pin (_pinned, event label as field) → no conflict/capacity errors
    {
        const assignments = {
            a1: [mk({ field: 'Showers Event', _activity: 'Showers Event', _pinned: true, _fixed: true })],
            a2: [mk({ field: 'Showers Event', _activity: 'Showers Event', _pinned: true, _fixed: true })],
            b1: [mk({ field: 'Showers Event', _activity: 'Showers Event', _pinned: true, _fixed: true })],
            c1: [mk({ field: 'Showers Event', _activity: 'Showers Event', _pinned: true, _fixed: true })],
        };
        const { w, v } = makeValidator({ divisions, fields, assignments, divisionTimes });
        const r = v.checkFieldConflicts(assignments, divisions, divisionTimes, w.ScheduleValidator ? { 'Court X': {} } : {}, bdm);
        check('T14a whole-grade custom pin no longer a cross-division/capacity violation',
            r.errors.length === 0 && r.warnings.length === 0, JSON.stringify(r.errors));
    }
    // T14b: pinned event WITH _reservedFields (AVL-style) → skipped by CHECK 1
    {
        const assignments = {
            a1: [mk({ field: 'AVL', _activity: 'AVL', _reservedFields: ['Court X'] })],
            a2: [mk({ field: 'AVL', _activity: 'AVL', _reservedFields: ['Court X'] })],
            b1: [mk({ field: 'AVL', _activity: 'AVL', _reservedFields: ['Court X'] })],
        };
        const { v } = makeValidator({ divisions, fields, assignments, divisionTimes });
        const r = v.checkFieldConflicts(assignments, divisions, divisionTimes, { 'Court X': {} }, bdm);
        check('T14b reserved-facility pin (AVL-style) skipped by CHECK 1',
            r.errors.length === 0, JSON.stringify(r.errors));
    }
    // T14c: unknown event label WITHOUT any pin flag (legacy pin) → still skipped
    {
        const assignments = {
            a1: [mk({ field: 'Toameha in day camp house', _activity: 'Toameha in day camp house' })],
            b1: [mk({ field: 'Toameha in day camp house', _activity: 'Toameha in day camp house' })],
        };
        const { v } = makeValidator({ divisions, fields, assignments, divisionTimes });
        const r = v.checkFieldConflicts(assignments, divisions, divisionTimes, { 'Court X': {} }, bdm);
        check('T14c unknown event label (no facility config) skipped by CHECK 1',
            r.errors.length === 0, JSON.stringify(r.errors));
    }
    // T14d REGRESSION: a REAL not_sharable field used cross-division still errors
    {
        const assignments = {
            a1: [mk({ field: 'Court X', _activity: 'Basketball' })],
            b1: [mk({ field: 'Court X', _activity: 'Basketball' })],
        };
        const { v } = makeValidator({ divisions, fields, assignments, divisionTimes });
        const r = v.checkFieldConflicts(assignments, divisions, divisionTimes, { 'Court X': {} }, bdm);
        check('T14d real not_sharable cross-division conflict STILL flagged',
            r.errors.length === 1 && /court x/i.test(r.errors[0]), JSON.stringify(r.errors));
    }
    // T14e: pinned event twice a day → no repetition error / field-reuse warning
    {
        const divisionTimes2 = { A: [{ startMin: 600, endMin: 660 }, { startMin: 1020, endMin: 1080 }] };
        const assignments = {
            a1: [
                { field: 'Showers Event', _activity: 'Showers Event', _pinned: true, _startMin: 600, _endMin: 660 },
                { field: 'Showers Event', _activity: 'Showers Event', _pinned: true, _startMin: 1020, _endMin: 1080 },
            ],
        };
        const { v } = makeValidator({ divisions: { A: { bunks: ['a1'] } }, fields, assignments, divisionTimes: divisionTimes2 });
        const reps = v.checkSameDayRepetitions(assignments, { a1: 'A' }, divisionTimes2);
        const reuse = v.checkSameDayFieldRepetitions(assignments, { a1: 'A' }, divisionTimes2);
        check('T14e pinned event twice a day: no repetition error, no field-reuse warning',
            reps.length === 0 && reuse.length === 0, JSON.stringify({ reps, reuse }));
    }
    // T14f REGRESSION: genuine same-day activity repetition still errors
    {
        const divisionTimes2 = { A: [{ startMin: 600, endMin: 660 }, { startMin: 1020, endMin: 1080 }] };
        const assignments = {
            a1: [
                { field: 'Court X', _activity: 'Basketball', _startMin: 600, _endMin: 660 },
                { field: 'Court X', _activity: 'Basketball', _startMin: 1020, _endMin: 1080 },
            ],
        };
        const { v } = makeValidator({ divisions: { A: { bunks: ['a1'] } }, fields, assignments, divisionTimes: divisionTimes2 });
        const reps = v.checkSameDayRepetitions(assignments, { a1: 'A' }, divisionTimes2);
        check('T14f genuine same-day repetition STILL flagged', reps.length === 1, JSON.stringify(reps));
    }
}

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
