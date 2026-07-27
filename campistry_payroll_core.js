// =============================================================================
// campistry_payroll_core.js — payroll math + youth-employment compliance rules
//
// Pure functions. No DOM, no storage, no implicit clock — every date-sensitive
// call takes the date it should reason about. That keeps the rules testable and
// keeps the "is this minor over hours?" answer identical wherever it's asked.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY YOUTH CORPS IS MODELLED SEPARATELY FROM ORDINARY STAFF
//
// Camps that take on teenage staff through a Youth Corps / Summer Youth
// Employment Program (NYC DYCD SYEP, county youth-bureau programs like
// Sullivan County's or Rockland's, or the federal Youth Conservation Corps)
// are acting as a WORKSITE for a program that employs the youth. That carries
// obligations the camp's own payroll doesn't:
//
//   • The program pays the participant, not the camp — so a Youth Corps
//     participant can sit on the roster with no camp salary and that is
//     correct, not missing data.
//   • Hours are capped by the program (25/week over ~6 weeks in July/August is
//     the common SYEP shape) ON TOP OF state child-labour limits.
//   • Timesheets are the deliverable. They're filled in weekly WITH the site
//     supervisor, signed, and submitted by the program's cutoff day; payroll
//     is committed on a fixed weekday, so a late sheet means an unpaid week.
//   • Worksites must name a supervisor and keep the ratio reasonable —
//     programs commonly ask for one supervisor per 10–15 youth.
//   • Participants attend an orientation BEFORE placement.
//
// Separately, New York requires an employment certificate ("working papers")
// for anyone 14–17 before their first day, which needs a physical-fitness
// certificate to obtain. Hour limits vary by age band, with one carve-out that
// matters enormously here: a 17-year-old working as a counselor, junior
// counselor or CIT at a children's camp in June, July or August is exempt from
// the hour restrictions. That exemption is why a generic "minor hours" check
// would fire constantly at a summer camp and get ignored.
//
// Rules encoded below are New York's, because that's where the camps this was
// built for operate. `REGION` names it so a second region can be added without
// anyone mistaking these for universal law. None of this is legal advice — the
// checks are there to surface what to go confirm.
// ─────────────────────────────────────────────────────────────────────────────
//
// Exposed as window.PayrollCore (browser) and module.exports (tests).
// =============================================================================
(function () {
    'use strict';

    var P = {};

    P.REGION = 'NY';

    // ── shared date helpers ──────────────────────────────────────────────────
    // Y-M-D strings only; see campistry_birthdays.js for why Date parsing of
    // 'YYYY-MM-DD' is avoided.
    function parseYmd(s) {
        if (!s) return null;
        var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s).trim());
        if (!m) return null;
        var o = { y: +m[1], m: +m[2], d: +m[3] };
        if (o.m < 1 || o.m > 12 || o.d < 1 || o.d > 31) return null;
        return o;
    }
    P.parseYmd = parseYmd;

    /** Age on a date. Null when either date is missing or unusable. */
    P.ageOn = function (dob, onDate) {
        var b = parseYmd(dob), o = parseYmd(onDate);
        if (!b || !o || b.y < 1900) return null;
        var age = o.y - b.y;
        if (o.m < b.m || (o.m === b.m && o.d < b.d)) age--;
        return (age >= 0 && age < 130) ? age : null;
    };

    // ── pay types ────────────────────────────────────────────────────────────
    P.PAY_TYPES = [
        { id: 'hourly',  label: 'Hourly',            rateLabel: 'Rate / hour' },
        { id: 'salary',  label: 'Season salary',     rateLabel: 'Total for the season' },
        { id: 'weekly',  label: 'Weekly',            rateLabel: 'Per week' },
        { id: 'stipend', label: 'Stipend (flat)',    rateLabel: 'Flat amount' },
        { id: 'program', label: 'Paid by program',   rateLabel: 'Program rate / hour' }
    ];

    // Payment methods for paying STAFF. Direct deposit, check and payroll card
    // (which is what SYEP itself issues). A personal debit card is not a
    // disbursement channel and is deliberately absent — same stance as the
    // canteen, for a different reason.
    P.PAY_METHODS = [
        { id: 'direct_deposit', label: 'Direct deposit' },
        { id: 'check',          label: 'Check' },
        { id: 'paycard',        label: 'Payroll card' },
        { id: 'cash',           label: 'Cash' }
    ];

    /**
     * Gross pay for one pay period.
     *
     * `program` pay types return 0 from the CAMP's payroll on purpose: the
     * program cuts that cheque, so counting it as camp expense would double it.
     * The hours still matter for compliance, which is why they're returned.
     */
    P.grossPay = function (staff, o) {
        staff = staff || {}; o = o || {};
        var rate = parseFloat(staff.payRate) || 0;
        var hours = parseFloat(o.hours) || 0;
        var periods = parseFloat(o.periodsInSeason) || 1;
        var weeks = parseFloat(o.weeks) || 1;
        switch (staff.payType) {
            case 'hourly':  return round2(rate * hours);
            case 'weekly':  return round2(rate * weeks);
            case 'salary':  return round2(periods > 0 ? rate / periods : rate);
            case 'stipend': return o.finalPeriod ? round2(rate) : 0;
            case 'program': return 0;
            default:        return round2(rate * hours);
        }
    };

    function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }
    P.round2 = round2;

    /** What the camp itself is on the hook for across a whole season. */
    P.seasonCost = function (staffList, o) {
        o = o || {};
        return round2((staffList || []).reduce(function (sum, s) {
            if (!s) return sum;
            if (s.payType === 'program') return sum;          // program pays, not us
            if (s.payType === 'salary' || s.payType === 'stipend') return sum + (parseFloat(s.payRate) || 0);
            var weeks = parseFloat(s.seasonWeeks) || parseFloat(o.weeks) || 7;
            if (s.payType === 'weekly') return sum + (parseFloat(s.payRate) || 0) * weeks;
            var hrs = parseFloat(s.expectedWeeklyHours) || 0;
            return sum + (parseFloat(s.payRate) || 0) * hrs * weeks;
        }, 0));
    };

    // ── New York hour + certificate rules ────────────────────────────────────
    /**
     * Hour limits and paperwork for a worker of `age`, in the month given.
     *
     * @param {number} age
     * @param {object} o  month (1-12), isCampCounselor (bool)
     * @returns {object} { requiresWorkingPapers, maxDaily, maxWeekly,
     *                     earliest, latest, exempt, note }
     */
    P.minorRules = function (age, o) {
        o = o || {};
        var month = o.month || 7;
        var summer = month >= 6 && month <= 8;

        if (age == null || age >= 18) {
            return { requiresWorkingPapers: false, maxDaily: null, maxWeekly: null,
                     earliest: null, latest: null, exempt: true,
                     note: age == null ? 'No date of birth on file — age rules not checked'
                                       : 'Adult — no minor hour limits' };
        }
        if (age < 14) {
            return { requiresWorkingPapers: true, maxDaily: 0, maxWeekly: 0,
                     earliest: null, latest: null, exempt: false, underMinimumAge: true,
                     note: 'Under 14 — cannot be employed at a camp in New York' };
        }
        // The carve-out that matters at a camp: NY exempts a 17-year-old
        // employed as a counselor / junior counselor / CIT at a children's camp
        // during June, July and August from the hour restrictions. Without
        // this, every head counselor's 17-year-old JC trips a false alarm.
        if (age === 17 && o.isCampCounselor && summer) {
            return { requiresWorkingPapers: true, maxDaily: null, maxWeekly: null,
                     earliest: null, latest: null, exempt: true,
                     note: 'Age 17 counselor at a children\'s camp in June–August — exempt from NY hour limits' };
        }
        if (age >= 16) {
            return { requiresWorkingPapers: true, maxDaily: 8, maxWeekly: 48,
                     earliest: '06:00', latest: '24:00', exempt: false,
                     note: 'Ages 16–17: up to 8 h/day, 48 h/week, 6:00 AM–midnight' };
        }
        // 14–15. Outside school hours the cap is 8/day and 40/week; the evening
        // curfew relaxes from 7 PM to 9 PM between June 21 and Labor Day.
        return { requiresWorkingPapers: true, maxDaily: 8, maxWeekly: 40,
                 earliest: '07:00', latest: summer ? '21:00' : '19:00', exempt: false,
                 note: summer
                    ? 'Ages 14–15 in summer: up to 8 h/day, 40 h/week, 7:00 AM–9:00 PM'
                    : 'Ages 14–15: up to 8 h/day, 40 h/week, 7:00 AM–7:00 PM' };
    };

    // ── Youth Corps program defaults ─────────────────────────────────────────
    // Shaped after the common SYEP / county youth-bureau summer program.
    P.YOUTH_CORPS_DEFAULTS = {
        programName: '',
        worksiteName: '',
        worksiteId: '',
        coordinatorName: '',
        coordinatorPhone: '',
        coordinatorEmail: '',
        supervisorName: '',
        startDate: '',
        endDate: '',
        maxWeeklyHours: 25,        // SYEP's usual cap
        programWeeks: 6,
        hourlyRate: 0,             // program pays at state minimum wage
        paidBy: 'program',         // 'program' | 'camp'
        timesheetDueDay: 4,        // 0=Sun … 4=Thu — Sullivan County's Thursday
        payrollCommitDay: 2,       // Tuesday — the week's hours are committed
        orientationHours: 8,       // pre-placement orientation
        supervisorRatioMax: 15,    // programs commonly ask 1 per 10–15 youth
        minAge: 14,
        maxAge: 24
    };

    P.youthCorpsSettings = function (raw) {
        var s = Object.assign({}, P.YOUTH_CORPS_DEFAULTS, (raw && typeof raw === 'object') ? raw : {});
        s.maxWeeklyHours = Math.max(0, parseFloat(s.maxWeeklyHours) || 0);
        s.programWeeks = Math.max(0, parseInt(s.programWeeks, 10) || 0);
        s.supervisorRatioMax = Math.max(1, parseInt(s.supervisorRatioMax, 10) || 15);
        s.minAge = Math.max(0, parseInt(s.minAge, 10) || 14);
        s.maxAge = Math.max(s.minAge, parseInt(s.maxAge, 10) || 24);
        return s;
    };

    var SEV = { blocker: 3, warn: 2, info: 1 };
    P.SEVERITY_ORDER = SEV;

    /**
     * Per-person compliance for a Youth Corps participant.
     *
     * Returns a checklist rather than a boolean, because the office needs to
     * know WHICH item is outstanding. `ok:null` means "can't tell from the data
     * we have" — surfaced as its own state so a blank field never reads as a
     * pass.
     */
    P.participantChecklist = function (staff, program, today) {
        staff = staff || {};
        var prog = P.youthCorpsSettings(program);
        var yc = staff.youthCorps || {};
        var asOf = today || (prog.startDate || '');
        var age = P.ageOn(staff.dob, asOf);
        var items = [];

        function add(id, label, ok, severity, detail) {
            items.push({ id: id, label: label, ok: ok, severity: severity, detail: detail || '' });
        }

        // Age eligibility
        if (age == null) {
            add('age', 'Age on file', null, 'warn', 'No date of birth — eligibility can\'t be checked');
        } else if (age < prog.minAge || age > prog.maxAge) {
            add('age', 'Age eligibility', false, 'blocker',
                'Age ' + age + ' is outside the program range (' + prog.minAge + '–' + prog.maxAge + ')');
        } else {
            add('age', 'Age eligibility', true, 'info', 'Age ' + age);
        }

        // Working papers — required for 14–17 in NY, before the first day.
        var needsPapers = age != null && age >= 14 && age < 18;
        if (needsPapers) {
            if (!yc.workingPapers) {
                add('papers', 'Working papers (employment certificate)', false, 'blocker',
                    'Required before the first day for anyone 14–17');
            } else if (yc.workingPapersExpiry && asOf && yc.workingPapersExpiry < asOf) {
                add('papers', 'Working papers', false, 'blocker',
                    'Expired ' + yc.workingPapersExpiry);
            } else {
                add('papers', 'Working papers', true, 'info',
                    yc.workingPapersExpiry ? 'Valid through ' + yc.workingPapersExpiry : 'On file');
            }
            // Working papers are issued off a physical-fitness certificate.
            add('physical', 'Physical / fitness certificate', !!yc.physicalOnFile,
                yc.physicalOnFile ? 'info' : 'warn',
                yc.physicalOnFile ? 'On file' : 'Needed to obtain working papers');
        } else if (age != null) {
            add('papers', 'Working papers', true, 'info', 'Not required at ' + age);
        } else {
            add('papers', 'Working papers', null, 'warn', 'Unknown — no date of birth');
        }

        // Orientation before placement
        add('orientation', 'Program orientation completed', !!yc.orientationDate,
            yc.orientationDate ? 'info' : 'blocker',
            yc.orientationDate ? 'Completed ' + yc.orientationDate
                               : prog.orientationHours + '-hour orientation is required before placement');

        // Enrolment identity
        add('participantId', 'Program participant ID', !!yc.participantId,
            yc.participantId ? 'info' : 'warn',
            yc.participantId ? String(yc.participantId) : 'Needed to match the program\'s payroll');

        // Named site supervisor
        var sup = yc.supervisorName || prog.supervisorName;
        add('supervisor', 'Site supervisor named', !!sup, sup ? 'info' : 'blocker',
            sup ? String(sup) : 'The worksite must name a supervisor for this participant');

        // How the participant gets paid
        add('payment', 'Payment method on file', !!yc.paymentMethod,
            yc.paymentMethod ? 'info' : 'warn',
            yc.paymentMethod ? P.payMethodLabel(yc.paymentMethod)
                             : 'Direct deposit or payroll card');

        // Addresses. Home is the payroll-of-record address; summer is where
        // they actually are during the season, which the camp needs for mail
        // and emergencies and which is almost never the same.
        add('homeAddress', 'Home address', !!(staff.homeAddress && staff.homeAddress.street),
            (staff.homeAddress && staff.homeAddress.street) ? 'info' : 'warn',
            'Payroll address of record');
        var hasSummer = !!(staff.summerAddressSameAsHome ||
                           (staff.summerAddress && staff.summerAddress.street));
        add('summerAddress', 'Summer address', hasSummer, hasSummer ? 'info' : 'warn',
            staff.summerAddressSameAsHome ? 'Same as home' : 'Where they are during the season');

        // Federal new-hire paperwork
        add('i9', 'I-9 on file', !!staff.i9OnFile, staff.i9OnFile ? 'info' : 'warn', '');
        add('w4', 'W-4 on file', !!staff.w4OnFile, staff.w4OnFile ? 'info' : 'warn', '');

        var blockers = items.filter(function (i) { return i.ok === false && i.severity === 'blocker'; });
        var warnings = items.filter(function (i) { return i.ok !== true && i.severity === 'warn'; });
        return {
            items: items,
            age: age,
            blockers: blockers,
            warnings: warnings,
            clearedToWork: blockers.length === 0,
            complete: items.every(function (i) { return i.ok === true; })
        };
    };

    P.payMethodLabel = function (id) {
        var m = P.PAY_METHODS.filter(function (x) { return x.id === id; })[0];
        return m ? m.label : (id || '—');
    };

    /** Program-level checks that only make sense across the whole cohort. */
    P.programChecklist = function (program, participants) {
        var prog = P.youthCorpsSettings(program);
        var list = participants || [];
        var items = [];
        function add(id, label, ok, severity, detail) {
            items.push({ id: id, label: label, ok: ok, severity: severity, detail: detail || '' });
        }
        add('program', 'Program named', !!prog.programName, prog.programName ? 'info' : 'warn',
            prog.programName || 'e.g. SYEP, county youth bureau');
        add('worksite', 'Worksite ID on file', !!prog.worksiteId, prog.worksiteId ? 'info' : 'warn',
            prog.worksiteId || 'Assigned by the program');
        add('coordinator', 'Program coordinator contact', !!(prog.coordinatorName || prog.coordinatorEmail),
            (prog.coordinatorName || prog.coordinatorEmail) ? 'info' : 'warn', prog.coordinatorName || '');
        add('dates', 'Program dates set', !!(prog.startDate && prog.endDate),
            (prog.startDate && prog.endDate) ? 'info' : 'warn',
            (prog.startDate && prog.endDate) ? prog.startDate + ' → ' + prog.endDate : '');

        // Supervisor ratio. Count distinct named supervisors across the cohort;
        // programs typically want no more than 10–15 youth per supervisor.
        var supervisors = {};
        list.forEach(function (s) {
            var n = (s && s.youthCorps && s.youthCorps.supervisorName) || prog.supervisorName || '';
            if (n) supervisors[String(n).toLowerCase()] = 1;
        });
        var supCount = Object.keys(supervisors).length;
        var needed = Math.ceil(list.length / prog.supervisorRatioMax);
        if (!list.length) {
            add('ratio', 'Supervisor coverage', null, 'info', 'No participants yet');
        } else if (!supCount) {
            add('ratio', 'Supervisor coverage', false, 'blocker', 'No supervisor named for any participant');
        } else {
            add('ratio', 'Supervisor coverage', supCount >= needed, supCount >= needed ? 'info' : 'warn',
                supCount + ' supervisor' + (supCount === 1 ? '' : 's') + ' for ' + list.length +
                ' participant' + (list.length === 1 ? '' : 's') +
                ' — program allows up to ' + prog.supervisorRatioMax + ' each');
        }
        return {
            items: items,
            participantCount: list.length,
            supervisorCount: supCount,
            supervisorsNeeded: needed
        };
    };

    // ── timesheets ───────────────────────────────────────────────────────────
    P.DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    P.DAY_LABELS = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };

    P.timesheetTotal = function (sheet) {
        var days = (sheet && sheet.days) || {};
        return round2(P.DAY_KEYS.reduce(function (s, k) { return s + (parseFloat(days[k]) || 0); }, 0));
    };

    /**
     * Everything wrong with one week of hours for one person.
     *
     * Checks state child-labour caps (via minorRules) AND, for Youth Corps
     * participants, the program's own weekly cap — a participant can be well
     * inside NY's 40 hours and still blow through the program's 25, which is
     * the failure that actually costs a camp its placement.
     */
    P.checkTimesheet = function (sheet, staff, o) {
        o = o || {};
        staff = staff || {};
        sheet = sheet || {};
        var prog = P.youthCorpsSettings(o.program);
        var total = P.timesheetTotal(sheet);
        var weekOf = sheet.weekOf || o.weekOf || '';
        var month = parseYmd(weekOf) ? parseYmd(weekOf).m : (o.month || 7);
        var age = P.ageOn(staff.dob, weekOf || o.today);
        var rules = P.minorRules(age, {
            month: month,
            isCampCounselor: staff.isCampCounselor !== false
        });
        var issues = [];

        if (rules.underMinimumAge && total > 0) {
            issues.push({ severity: 'blocker', code: 'under_age',
                message: 'Age ' + age + ' is below the minimum working age' });
        }
        if (rules.maxWeekly != null && total > rules.maxWeekly) {
            issues.push({ severity: 'blocker', code: 'weekly_hours',
                message: total + ' h exceeds the ' + rules.maxWeekly + ' h weekly limit for age ' + age });
        }
        if (rules.maxDaily != null) {
            var days = sheet.days || {};
            P.DAY_KEYS.forEach(function (k) {
                var h = parseFloat(days[k]) || 0;
                if (h > rules.maxDaily) {
                    issues.push({ severity: 'blocker', code: 'daily_hours',
                        message: P.DAY_LABELS[k] + ': ' + h + ' h exceeds the ' + rules.maxDaily +
                                 ' h daily limit for age ' + age });
                }
            });
        }
        var inCorps = !!(staff.youthCorps && staff.youthCorps.enrolled);
        if (inCorps && prog.maxWeeklyHours > 0 && total > prog.maxWeeklyHours) {
            issues.push({ severity: 'blocker', code: 'program_hours',
                message: total + ' h exceeds the program cap of ' + prog.maxWeeklyHours + ' h/week' });
        }
        if (inCorps && !sheet.supervisorSigned) {
            issues.push({ severity: 'warn', code: 'unsigned',
                message: 'Not signed by the site supervisor — the program won\'t pay an unsigned sheet' });
        }
        if (sheet.status === 'submitted' || sheet.status === 'approved') {
            // Nothing further; a submitted sheet is the program's problem now.
        } else if (inCorps && o.today && weekOf && P.weekIsClosed(weekOf, o.today)) {
            issues.push({ severity: 'warn', code: 'late',
                message: 'Week has ended and the sheet still isn\'t submitted' });
        }

        return {
            total: total,
            age: age,
            rules: rules,
            issues: issues,
            blockers: issues.filter(function (i) { return i.severity === 'blocker'; }),
            ok: issues.length === 0
        };
    };

    /** True once `today` is past the Saturday of the week starting `weekOf`. */
    P.weekIsClosed = function (weekOf, today) {
        var w = parseYmd(weekOf), t = parseYmd(today);
        if (!w || !t) return false;
        var start = Date.UTC(w.y, w.m - 1, w.d);
        var end = start + 6 * 86400000;
        return Date.UTC(t.y, t.m - 1, t.d) > end;
    };

    /** Roll a set of weekly sheets into per-person totals for a pay run. */
    P.summarizeSheets = function (sheets, o) {
        o = o || {};
        var byStaff = {};
        (sheets || []).forEach(function (sh) {
            if (!sh || !sh.staffId) return;
            if (o.from && sh.weekOf && sh.weekOf < o.from) return;
            if (o.to && sh.weekOf && sh.weekOf > o.to) return;
            var k = String(sh.staffId);
            if (!byStaff[k]) byStaff[k] = { staffId: sh.staffId, hours: 0, weeks: 0, unsigned: 0, unsubmitted: 0 };
            byStaff[k].hours = round2(byStaff[k].hours + P.timesheetTotal(sh));
            byStaff[k].weeks += 1;
            if (!sh.supervisorSigned) byStaff[k].unsigned += 1;
            if (sh.status !== 'submitted' && sh.status !== 'approved') byStaff[k].unsubmitted += 1;
        });
        return byStaff;
    };

    /**
     * A pay run: gross per person plus the totals the office needs.
     * Program-paid people are listed with their hours but $0 camp cost, and
     * counted separately so the number isn't mistaken for "unpaid".
     */
    P.buildPayRun = function (staffList, sheets, o) {
        o = o || {};
        var totals = P.summarizeSheets(sheets, o);
        var lines = [], campTotal = 0, programHours = 0, programPeople = 0;
        (staffList || []).forEach(function (s) {
            if (!s) return;
            var t = totals[String(s.id)] || { hours: 0, weeks: 0, unsigned: 0, unsubmitted: 0 };
            var gross = P.grossPay(s, {
                hours: t.hours, weeks: t.weeks || 1,
                periodsInSeason: o.periodsInSeason, finalPeriod: o.finalPeriod
            });
            if (s.payType === 'program') { programHours = round2(programHours + t.hours); programPeople++; }
            else campTotal = round2(campTotal + gross);
            lines.push({
                staffId: s.id, name: s.name || '', role: s.role || '',
                payType: s.payType || 'hourly', payRate: parseFloat(s.payRate) || 0,
                hours: t.hours, weeks: t.weeks, gross: gross,
                paidByProgram: s.payType === 'program',
                unsigned: t.unsigned, unsubmitted: t.unsubmitted,
                method: s.paymentMethod || ''
            });
        });
        lines.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
        return {
            from: o.from || '', to: o.to || '',
            lines: lines,
            campTotal: campTotal,
            programHours: programHours,
            programPeople: programPeople,
            headcount: lines.length
        };
    };

    if (typeof window !== 'undefined') window.PayrollCore = P;
    if (typeof module !== 'undefined' && module.exports) module.exports = P;
})();
