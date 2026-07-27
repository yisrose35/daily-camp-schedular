// node --test tests/payroll_core.test.js
// Validates payroll math + youth-employment compliance rules:
//   • NY hour bands by age, including the 17-year-old camp-counselor exemption
//   • working-papers / orientation / supervisor checks per participant
//   • the program weekly cap that sits ON TOP of state limits
//   • gross pay per pay type, and program-paid staff costing the camp $0
const test = require('node:test');
const assert = require('node:assert');
const P = require('../campistry_payroll_core.js');

// ── age ─────────────────────────────────────────────────────────────────────

test('ageOn: birthday not yet reached means one year younger', () => {
    assert.strictEqual(P.ageOn('2010-08-20', '2026-07-01'), 15);
    assert.strictEqual(P.ageOn('2010-07-01', '2026-07-01'), 16);   // on the day
    assert.strictEqual(P.ageOn('', '2026-07-01'), null);
    assert.strictEqual(P.ageOn('2010-08-20', ''), null);
});

// ── NY hour bands ───────────────────────────────────────────────────────────

test('minorRules: adults have no limits', () => {
    const r = P.minorRules(19, { month: 7 });
    assert.strictEqual(r.exempt, true);
    assert.strictEqual(r.requiresWorkingPapers, false);
    assert.strictEqual(r.maxWeekly, null);
});

test('minorRules: unknown age says so instead of silently passing', () => {
    const r = P.minorRules(null, { month: 7 });
    assert.match(r.note, /No date of birth/);
});

test('minorRules: under 14 cannot be employed', () => {
    const r = P.minorRules(13, { month: 7 });
    assert.strictEqual(r.underMinimumAge, true);
    assert.strictEqual(r.maxWeekly, 0);
    assert.strictEqual(r.requiresWorkingPapers, true);
});

test('minorRules: ages 14-15 get 8/day, 40/week, with a 9 PM summer curfew', () => {
    const summer = P.minorRules(15, { month: 7 });
    assert.strictEqual(summer.maxDaily, 8);
    assert.strictEqual(summer.maxWeekly, 40);
    assert.strictEqual(summer.latest, '21:00');

    const offSeason = P.minorRules(15, { month: 10 });
    assert.strictEqual(offSeason.latest, '19:00');
});

test('minorRules: ages 16-17 get 8/day, 48/week, 6 AM to midnight', () => {
    const r = P.minorRules(16, { month: 7 });
    assert.strictEqual(r.maxDaily, 8);
    assert.strictEqual(r.maxWeekly, 48);
    assert.strictEqual(r.earliest, '06:00');
    assert.strictEqual(r.latest, '24:00');
});

test('minorRules: a 17-year-old counselor is exempt in June-August only', () => {
    // This is the carve-out that keeps the check from crying wolf all summer.
    const july = P.minorRules(17, { month: 7, isCampCounselor: true });
    assert.strictEqual(july.exempt, true);
    assert.strictEqual(july.maxWeekly, null);
    assert.strictEqual(july.requiresWorkingPapers, true);   // papers still required

    const may = P.minorRules(17, { month: 5, isCampCounselor: true });
    assert.strictEqual(may.exempt, false);
    assert.strictEqual(may.maxWeekly, 48);

    const nonCounselor = P.minorRules(17, { month: 7, isCampCounselor: false });
    assert.strictEqual(nonCounselor.exempt, false);
    assert.strictEqual(nonCounselor.maxWeekly, 48);
});

// ── gross pay ───────────────────────────────────────────────────────────────

test('grossPay: hourly multiplies rate by hours', () => {
    assert.strictEqual(P.grossPay({ payType: 'hourly', payRate: 16.5 }, { hours: 24 }), 396);
});

test('grossPay: weekly multiplies by weeks, salary divides across periods', () => {
    assert.strictEqual(P.grossPay({ payType: 'weekly', payRate: 400 }, { weeks: 2 }), 800);
    assert.strictEqual(P.grossPay({ payType: 'salary', payRate: 7000 }, { periodsInSeason: 7 }), 1000);
});

test('grossPay: a stipend pays out once, on the final period', () => {
    const s = { payType: 'stipend', payRate: 1200 };
    assert.strictEqual(P.grossPay(s, { finalPeriod: false }), 0);
    assert.strictEqual(P.grossPay(s, { finalPeriod: true }), 1200);
});

test('grossPay: program-paid staff cost the camp nothing', () => {
    // The program cuts the cheque. Counting it here would double the expense.
    assert.strictEqual(P.grossPay({ payType: 'program', payRate: 16 }, { hours: 25 }), 0);
});

test('seasonCost: sums the camp side and skips program-paid people', () => {
    const cost = P.seasonCost([
        { payType: 'salary', payRate: 5000 },
        { payType: 'stipend', payRate: 1000 },
        { payType: 'weekly', payRate: 300, seasonWeeks: 7 },
        { payType: 'hourly', payRate: 15, expectedWeeklyHours: 40, seasonWeeks: 7 },
        { payType: 'program', payRate: 16, expectedWeeklyHours: 25, seasonWeeks: 6 }
    ], { weeks: 7 });
    // 5000 + 1000 + 2100 + 4200 + 0
    assert.strictEqual(cost, 12300);
});

// ── participant checklist ───────────────────────────────────────────────────

const PROG = {
    programName: 'SYEP', worksiteId: 'WS-1234', coordinatorName: 'A. Cohen',
    startDate: '2026-07-06', endDate: '2026-08-14', supervisorName: 'R. Klein',
    maxWeeklyHours: 25
};

function participant(over) {
    return Object.assign({
        id: 1, name: 'Shaya Weiss', dob: '2010-03-04', role: 'Junior Counselor',
        homeAddress: { street: '12 Main St' }, summerAddressSameAsHome: true,
        i9OnFile: true, w4OnFile: true,
        youthCorps: {
            enrolled: true, participantId: 'P-9001', workingPapers: true,
            workingPapersExpiry: '2027-03-04', physicalOnFile: true,
            orientationDate: '2026-06-29', supervisorName: 'R. Klein',
            paymentMethod: 'direct_deposit'
        }
    }, over || {});
}

function item(res, id) { return res.items.find(i => i.id === id); }

test('participantChecklist: a fully documented 16-year-old is cleared', () => {
    const res = P.participantChecklist(participant(), PROG, '2026-07-06');
    assert.strictEqual(res.age, 16);
    assert.strictEqual(res.clearedToWork, true);
    assert.strictEqual(res.complete, true);
    assert.strictEqual(res.blockers.length, 0);
});

test('participantChecklist: missing working papers blocks a minor', () => {
    const p = participant();
    p.youthCorps.workingPapers = false;
    const res = P.participantChecklist(p, PROG, '2026-07-06');
    assert.strictEqual(res.clearedToWork, false);
    assert.strictEqual(item(res, 'papers').ok, false);
    assert.strictEqual(item(res, 'papers').severity, 'blocker');
});

test('participantChecklist: expired working papers block too', () => {
    const p = participant();
    p.youthCorps.workingPapersExpiry = '2026-06-01';
    const res = P.participantChecklist(p, PROG, '2026-07-06');
    assert.strictEqual(item(res, 'papers').ok, false);
    assert.match(item(res, 'papers').detail, /Expired/);
});

test('participantChecklist: papers are not required at 18', () => {
    const res = P.participantChecklist(participant({ dob: '2008-01-01' }), PROG, '2026-07-06');
    assert.strictEqual(res.age, 18);
    assert.strictEqual(item(res, 'papers').ok, true);
    assert.match(item(res, 'papers').detail, /Not required/);
    // And the physical-certificate row only exists for minors.
    assert.strictEqual(item(res, 'physical'), undefined);
});

test('participantChecklist: age outside the program range is a blocker', () => {
    const res = P.participantChecklist(participant({ dob: '2013-01-01' }), PROG, '2026-07-06');
    assert.strictEqual(res.age, 13);
    assert.strictEqual(item(res, 'age').ok, false);
    assert.strictEqual(res.clearedToWork, false);
});

test('participantChecklist: a missing date of birth is unknown, not a pass', () => {
    const res = P.participantChecklist(participant({ dob: '' }), PROG, '2026-07-06');
    assert.strictEqual(item(res, 'age').ok, null);
    assert.strictEqual(item(res, 'papers').ok, null);
    assert.strictEqual(res.complete, false);
});

test('participantChecklist: orientation before placement is a blocker', () => {
    const p = participant();
    p.youthCorps.orientationDate = '';
    const res = P.participantChecklist(p, PROG, '2026-07-06');
    assert.strictEqual(item(res, 'orientation').ok, false);
    assert.strictEqual(item(res, 'orientation').severity, 'blocker');
});

test('participantChecklist: the program supervisor covers a participant with none of their own', () => {
    const p = participant();
    p.youthCorps.supervisorName = '';
    const withProgSup = P.participantChecklist(p, PROG, '2026-07-06');
    assert.strictEqual(item(withProgSup, 'supervisor').ok, true);

    const noSup = P.participantChecklist(p, Object.assign({}, PROG, { supervisorName: '' }), '2026-07-06');
    assert.strictEqual(item(noSup, 'supervisor').ok, false);
    assert.strictEqual(noSup.clearedToWork, false);
});

test('participantChecklist: home and summer addresses are tracked separately', () => {
    const res = P.participantChecklist(
        participant({ homeAddress: {}, summerAddressSameAsHome: false, summerAddress: {} }),
        PROG, '2026-07-06');
    assert.strictEqual(item(res, 'homeAddress').ok, false);
    assert.strictEqual(item(res, 'summerAddress').ok, false);

    const withSummer = P.participantChecklist(
        participant({ summerAddressSameAsHome: false, summerAddress: { street: 'Bunk 4, Camp Rd' } }),
        PROG, '2026-07-06');
    assert.strictEqual(item(withSummer, 'summerAddress').ok, true);
});

// ── program checklist ───────────────────────────────────────────────────────

test('programChecklist: supervisor ratio flags an over-loaded worksite', () => {
    // 20 participants, one supervisor, cap of 15 each → needs 2.
    const many = Array.from({ length: 20 }, (_, i) =>
        participant({ id: i, youthCorps: { enrolled: true, supervisorName: 'R. Klein' } }));
    const res = P.programChecklist(Object.assign({}, PROG, { supervisorRatioMax: 15 }), many);
    assert.strictEqual(res.supervisorCount, 1);
    assert.strictEqual(res.supervisorsNeeded, 2);
    assert.strictEqual(res.items.find(i => i.id === 'ratio').ok, false);
});

test('programChecklist: two supervisors clear a 20-person cohort', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
        participant({ id: i, youthCorps: { enrolled: true, supervisorName: i < 10 ? 'A' : 'B' } }));
    const res = P.programChecklist(PROG, many);
    assert.strictEqual(res.supervisorCount, 2);
    assert.strictEqual(res.items.find(i => i.id === 'ratio').ok, true);
});

test('programChecklist: no participants is not a failure', () => {
    const res = P.programChecklist(PROG, []);
    assert.strictEqual(res.items.find(i => i.id === 'ratio').ok, null);
});

test('youthCorpsSettings defaults to the common SYEP shape', () => {
    const s = P.youthCorpsSettings(null);
    assert.strictEqual(s.maxWeeklyHours, 25);
    assert.strictEqual(s.programWeeks, 6);
    assert.strictEqual(s.minAge, 14);
    assert.strictEqual(s.supervisorRatioMax, 15);
});

// ── timesheets ──────────────────────────────────────────────────────────────

const week = days => ({ weekOf: '2026-07-06', days, supervisorSigned: true, status: 'submitted' });

test('timesheetTotal sums the seven days', () => {
    assert.strictEqual(P.timesheetTotal(week({ mon: 5, tue: 5, wed: 5, thu: 5, fri: 5 })), 25);
    assert.strictEqual(P.timesheetTotal({}), 0);
});

test('checkTimesheet: within every cap is clean', () => {
    const res = P.checkTimesheet(week({ mon: 5, tue: 5, wed: 5, thu: 5, fri: 5 }), participant(), { program: PROG });
    assert.strictEqual(res.total, 25);
    assert.strictEqual(res.ok, true);
});

test('checkTimesheet: the program cap bites before the state cap does', () => {
    // 30 h is fine for a 16-year-old under NY (48/week) but blows SYEP's 25.
    // This is the failure that actually costs a camp its placement.
    const res = P.checkTimesheet(week({ mon: 6, tue: 6, wed: 6, thu: 6, fri: 6 }), participant(), { program: PROG });
    assert.strictEqual(res.total, 30);
    assert.ok(res.blockers.some(i => i.code === 'program_hours'));
    assert.ok(!res.blockers.some(i => i.code === 'weekly_hours'));
});

test('checkTimesheet: the state weekly cap fires for a 14-year-old', () => {
    const p = participant({ dob: '2011-01-01' });   // 15 on 2026-07-06
    p.youthCorps.enrolled = false;                  // no program cap in play
    const res = P.checkTimesheet(week({ mon: 9, tue: 9, wed: 9, thu: 9, fri: 9 }), p, {});
    assert.strictEqual(res.age, 15);
    assert.ok(res.blockers.some(i => i.code === 'weekly_hours'));
    assert.ok(res.blockers.some(i => i.code === 'daily_hours'));   // 9 > 8
});

test('checkTimesheet: an exempt 17-year-old counselor has no hour blockers', () => {
    const p = participant({ dob: '2009-01-01', isCampCounselor: true });  // 17
    p.youthCorps.enrolled = false;
    const res = P.checkTimesheet(week({ mon: 12, tue: 12, wed: 12, thu: 12, fri: 12 }), p, {});
    assert.strictEqual(res.age, 17);
    assert.strictEqual(res.rules.exempt, true);
    assert.strictEqual(res.blockers.length, 0);
});

test('checkTimesheet: an unsigned Youth Corps sheet is flagged', () => {
    const sheet = week({ mon: 5, tue: 5 });
    sheet.supervisorSigned = false;
    const res = P.checkTimesheet(sheet, participant(), { program: PROG });
    assert.ok(res.issues.some(i => i.code === 'unsigned'));
    assert.strictEqual(res.blockers.length, 0);   // a warning, not a blocker
});

test('checkTimesheet: a closed week that was never submitted is flagged late', () => {
    const sheet = { weekOf: '2026-07-06', days: { mon: 5 }, supervisorSigned: true, status: 'draft' };
    const res = P.checkTimesheet(sheet, participant(), { program: PROG, today: '2026-07-20' });
    assert.ok(res.issues.some(i => i.code === 'late'));

    const stillOpen = P.checkTimesheet(sheet, participant(), { program: PROG, today: '2026-07-09' });
    assert.ok(!stillOpen.issues.some(i => i.code === 'late'));
});

test('weekIsClosed spans Sunday to Saturday inclusive', () => {
    assert.strictEqual(P.weekIsClosed('2026-07-06', '2026-07-12'), false);  // last day
    assert.strictEqual(P.weekIsClosed('2026-07-06', '2026-07-13'), true);
    assert.strictEqual(P.weekIsClosed('', '2026-07-13'), false);
});

// ── pay run ─────────────────────────────────────────────────────────────────

test('summarizeSheets: totals per person, filtered to the period', () => {
    const sheets = [
        { staffId: 1, weekOf: '2026-07-06', days: { mon: 5, tue: 5 }, supervisorSigned: true, status: 'approved' },
        { staffId: 1, weekOf: '2026-07-13', days: { mon: 4 }, supervisorSigned: false, status: 'draft' },
        { staffId: 2, weekOf: '2026-07-06', days: { mon: 8 }, supervisorSigned: true, status: 'approved' },
        { staffId: 1, weekOf: '2026-06-01', days: { mon: 8 }, supervisorSigned: true, status: 'approved' }
    ];
    const t = P.summarizeSheets(sheets, { from: '2026-07-01', to: '2026-07-31' });
    assert.strictEqual(t['1'].hours, 14);
    assert.strictEqual(t['1'].weeks, 2);
    assert.strictEqual(t['1'].unsigned, 1);
    assert.strictEqual(t['1'].unsubmitted, 1);
    assert.strictEqual(t['2'].hours, 8);
});

test('buildPayRun: camp total excludes program-paid people but keeps their hours', () => {
    const staff = [
        { id: 1, name: 'Rivky', payType: 'hourly', payRate: 16 },
        { id: 2, name: 'Shaya', payType: 'program', payRate: 16 }
    ];
    const sheets = [
        { staffId: 1, weekOf: '2026-07-06', days: { mon: 8, tue: 8 }, status: 'approved', supervisorSigned: true },
        { staffId: 2, weekOf: '2026-07-06', days: { mon: 5, tue: 5, wed: 5 }, status: 'approved', supervisorSigned: true }
    ];
    const run = P.buildPayRun(staff, sheets, { from: '2026-07-01', to: '2026-07-31' });
    assert.strictEqual(run.headcount, 2);
    assert.strictEqual(run.campTotal, 256);        // 16 h × $16, Rivky only
    assert.strictEqual(run.programHours, 15);
    assert.strictEqual(run.programPeople, 1);
    const shaya = run.lines.find(l => l.name === 'Shaya');
    assert.strictEqual(shaya.gross, 0);
    assert.strictEqual(shaya.hours, 15);
    assert.strictEqual(shaya.paidByProgram, true);
});

test('buildPayRun: staff with no hours still appear, at zero', () => {
    const run = P.buildPayRun([{ id: 9, name: 'Nobody', payType: 'hourly', payRate: 20 }], [], {});
    assert.strictEqual(run.lines.length, 1);
    assert.strictEqual(run.lines[0].hours, 0);
    assert.strictEqual(run.lines[0].gross, 0);
});
