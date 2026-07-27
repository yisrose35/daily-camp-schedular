// =============================================================================
// campistry_birthdays.js — whose birthday is coming up
//
// Pure date arithmetic over a list of people with a date of birth. No DOM, no
// storage, and no hidden clock: every function takes `today` explicitly, so the
// results are deterministic and testable (and so a camp in a different
// timezone can't get yesterday's answer).
//
// Dates are handled as plain Y-M-D strings, never as Date objects with a time
// component. Parsing 'YYYY-MM-DD' with `new Date()` treats it as UTC midnight,
// which lands on the PREVIOUS day for anyone west of Greenwich — that's the
// classic "the birthday showed a day early" bug, so we don't go near it.
//
// Leap day: someone born Feb 29 is observed on Feb 28 in a non-leap year. The
// reminder then lands a day early rather than a day late, which is the right
// direction for a camp that needs to bake a cake.
//
// Exposed as window.CampistryBirthdays (browser) and module.exports (tests).
// =============================================================================
(function () {
    'use strict';

    var B = {};

    /** 'YYYY-MM-DD' → { y, m, d } (1-based month), or null if unusable. */
    function parseYmd(s) {
        if (!s) return null;
        var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s).trim());
        if (!m) return null;
        var y = +m[1], mo = +m[2], d = +m[3];
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        return { y: y, m: mo, d: d };
    }
    B.parseYmd = parseYmd;

    function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
    B.isLeap = isLeap;

    function daysInMonth(y, m) {
        return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    }

    /** Day number since an arbitrary epoch — only ever used for differences. */
    function dayNumber(y, m, d) {
        return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
    }

    /** Today as { y, m, d } in the LOCAL timezone. */
    B.todayYmd = function (now) {
        var t = now || new Date();
        return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
    };

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    B.formatYmd = function (o) { return o.y + '-' + pad(o.m) + '-' + pad(o.d); };

    /**
     * The next occurrence of a month/day on or after `today`, clamped for the
     * leap-day case. Returns { y, m, d, daysUntil }.
     */
    B.nextOccurrence = function (month, day, today) {
        var t = today;
        var todayNum = dayNumber(t.y, t.m, t.d);
        for (var y = t.y; y <= t.y + 1; y++) {
            var d = Math.min(day, daysInMonth(y, month));   // Feb 29 → Feb 28
            var n = dayNumber(y, month, d);
            if (n >= todayNum) return { y: y, m: month, d: d, daysUntil: n - todayNum };
        }
        // Unreachable for valid input, but never return undefined.
        return { y: t.y + 1, m: month, d: day, daysUntil: 365 };
    };

    /**
     * Age on a given date. Null when the date of birth has no year we trust
     * (some rosters carry only a month and day).
     */
    B.ageOn = function (dob, on) {
        if (!dob || !dob.y || dob.y < 1900) return null;
        var age = on.y - dob.y;
        if (on.m < dob.m || (on.m === dob.m && on.d < dob.d)) age--;
        return age >= 0 && age < 130 ? age : null;
    };

    /**
     * Upcoming birthdays, soonest first.
     *
     * @param {Array} people  [{ name, dob, kind, division, bunk, ... }]
     *                        `dob` is 'YYYY-MM-DD'; anything unparseable is
     *                        skipped rather than guessed at.
     * @param {object} opts   today   { y, m, d } — defaults to the local date
     *                        windowDays  how far ahead to look (default 30)
     *                        includeToday  default true
     * @returns {Array} [{ ...person, month, day, on, daysUntil, isToday,
     *                     turningAge, currentAge }]
     */
    B.upcoming = function (people, opts) {
        opts = opts || {};
        var today = opts.today || B.todayYmd();
        var windowDays = opts.windowDays == null ? 30 : Math.max(0, opts.windowDays);
        var includeToday = opts.includeToday !== false;

        var out = [];
        (people || []).forEach(function (p) {
            if (!p) return;
            var dob = parseYmd(p.dob);
            if (!dob) return;
            var next = B.nextOccurrence(dob.m, dob.d, today);
            if (next.daysUntil > windowDays) return;
            if (next.daysUntil === 0 && !includeToday) return;
            var turning = dob.y && dob.y >= 1900 ? next.y - dob.y : null;
            out.push(Object.assign({}, p, {
                month: dob.m, day: dob.d,
                on: B.formatYmd(next),
                daysUntil: next.daysUntil,
                isToday: next.daysUntil === 0,
                turningAge: turning,
                currentAge: B.ageOn(dob, today)
            }));
        });
        // Soonest first; same-day ties alphabetical so the list is stable.
        out.sort(function (a, b) {
            return a.daysUntil - b.daysUntil ||
                String(a.name || '').localeCompare(String(b.name || ''));
        });
        return out;
    };

    /** Just today's birthdays. */
    B.todays = function (people, opts) {
        return B.upcoming(people, Object.assign({}, opts, { windowDays: 0 }));
    };

    /** "Today" / "Tomorrow" / "In 4 days" / "Sun, Aug 3". */
    B.relativeLabel = function (entry, opts) {
        if (!entry) return '';
        var n = entry.daysUntil;
        if (n === 0) return 'Today';
        if (n === 1) return 'Tomorrow';
        if (n <= 6) return 'In ' + n + ' days';
        try {
            var d = new Date(entry.y || 2000, (entry.month || 1) - 1, entry.day || 1);
            // Build from the resolved occurrence so the weekday is right.
            var parts = entry.on.split('-');
            d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
            return d.toLocaleDateString((opts && opts.locale) || 'en-US',
                { weekday: 'short', month: 'short', day: 'numeric' });
        } catch (e) {
            return 'In ' + n + ' days';
        }
    };

    /**
     * Pull everyone with a birthday out of a campGlobalSettings_v1 blob.
     * Campers come from app1.camperRoster; staff from campistryMe.payroll.staff
     * (the payroll record) and campistryMe.finance.staff (the older finance
     * list), deduped by name with the payroll record winning.
     */
    B.collectFromSettings = function (settings) {
        var s = settings || {};
        var people = [];
        var roster = (s.app1 && s.app1.camperRoster) || {};
        Object.keys(roster).forEach(function (name) {
            var c = roster[name] || {};
            if (!c.dob) return;
            people.push({
                name: name, dob: c.dob, kind: 'camper',
                division: c.division || '', bunk: c.bunk || '', grade: c.grade || ''
            });
        });

        var me = s.campistryMe || {};
        var seenStaff = {};
        var staffLists = [
            (me.payroll && me.payroll.staff) || [],
            (me.finance && me.finance.staff) || []
        ];
        staffLists.forEach(function (list) {
            (Array.isArray(list) ? list : []).forEach(function (st) {
                if (!st || !st.dob || !st.name) return;
                var key = String(st.name).toLowerCase();
                if (seenStaff[key]) return;
                seenStaff[key] = 1;
                people.push({
                    name: st.name, dob: st.dob, kind: 'staff',
                    role: st.role || '', bunk: st.bunk || '', division: ''
                });
            });
        });
        return people;
    };

    if (typeof window !== 'undefined') window.CampistryBirthdays = B;
    if (typeof module !== 'undefined' && module.exports) module.exports = B;
})();
