/* =============================================================================
 * campistry_enrollment_window.js — enrolled is a billing fact. Present is a
 * date fact. They are not the same thing, and this app had only one of them.
 *
 * WHY THIS EXISTS. A camp runs two halves. A family registers for the second
 * half in March; that child is enrolled, billed, on the roster, and NOT IN CAMP
 * until July. A first-half child is in camp in June and gone in July, still
 * enrolled the whole time as far as their account is concerned. Campistry had
 * exactly one flag for all of this — `roster[name].unenrolled`, set by hand —
 * so every list, every parent view and every count treated a child who arrives
 * in three weeks identically to one sitting in a bunk today.
 *
 * What that costs:
 *
 *   THE OFFICE looks at the roster in June and sees the second-half children
 *     mixed in with the ones actually there. Head counts, bunk lists and
 *     attendance are all wrong by however many children have not arrived.
 *
 *   THE PARENT of a second-half child opens Link in June and gets the full
 *     portal — schedules, messages, pickup, photos — for a child who is not at
 *     camp. What they actually need in June is the one thing they do have
 *     business with: their bill.
 *
 * SESSIONS ALREADY CARRY THE ANSWER. Every session has `startDate` and
 * `endDate` (and a camp's two halves are auto-created as sessions from
 * campDates), and every enrollment names its session. So presence is derivable
 * and never needs to be stamped, set or maintained — which matters, because the
 * last attempt at this (migration 035) gated on an `accessStart`/`accessEnd`
 * pair copied onto each camper, nothing kept them in step, and migration 039
 * ripped the whole thing out when it locked families out of their own accounts.
 * Deriving it from the session means editing a session's dates moves everybody
 * who is on it, immediately, with nothing to re-stamp.
 *
 * THE FOUR STATES
 *
 *   active    in camp on the date asked about — some live enrollment's session
 *             covers it.
 *   upcoming  enrolled, but their earliest session has not started yet.
 *   ended     every session they are on has finished.
 *   none      no live enrollment at all, or the office unenrolled them by hand.
 *
 * THE RULE THAT STOPS THIS REPEATING 039'S MISTAKE: A SESSION WITH NO DATES
 * CANNOT DATE-GATE ANYBODY. A camp that has not filled in start and end dates
 * gets `active`, always. Every single way this module can fail to know something
 * resolves towards access, because the cost of wrongly saying "present" is a
 * name on a list, and the cost of wrongly saying "absent" is a family locked out
 * of their own child's account.
 *
 * Pure: enrollments, sessions and a date in; a verdict out. It reads no app
 * state, holds no clock of its own, and decides nothing about what a caller
 * does with the answer.
 * ========================================================================== */
(function (root) {
    'use strict';
    var W = {};

    /** Statuses that mean a real, billable place at camp. */
    W.LIVE_STATUS = { enrolled: 1, accepted: 1 };

    function ymd(d) { return String(d == null ? '' : d).slice(0, 10); }
    function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

    /** Today, as the app's own date strings look. Callers may override it. */
    W.today = function (now) {
        var d = (now instanceof Date) ? now : new Date();
        return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
            .toISOString().slice(0, 10);
    };

    /**
     * The date window one session covers.
     *
     * Returns {from, to} with either side null when the camp has not said. A
     * session with neither is `{from:null,to:null}`, which every caller below
     * reads as "always open" — see the header.
     */
    W.sessionWindow = function (session) {
        if (!session || typeof session !== 'object') return { from: null, to: null };
        var a = ymd(session.startDate), b = ymd(session.endDate);
        var from = isDate(a) ? a : null, to = isDate(b) ? b : null;
        // A start after an end is not a window, it is a typo. Treating it as a
        // window would gate a family on nonsense, so it gates nobody: both ends
        // are dropped and the session reads as undated.
        if (from && to && from > to) return { from: null, to: null, unusable: true };
        return { from: from, to: to };
    };

    /** Does this session cover `on`? An undated session covers everything. */
    W.sessionCovers = function (session, on) {
        var w = W.sessionWindow(session);
        var day = ymd(on);
        if (!isDate(day)) return true;                      // no date asked about
        if (w.from && day < w.from) return false;
        if (w.to && day > w.to) return false;
        return true;
    };

    /**
     * Where one camper stands on one date.
     *
     * o = {
     *   camperName,
     *   enrollments: { id: {camperName, session, status} },
     *   sessions:    [ {name, startDate, endDate} ],
     *   roster:      { 'Eli Klein': {unenrolled:true} },   // optional
     *   on:          '2026-06-20'
     * }
     *
     * Returns { state, reason, session, from, to, sessions:[…] } where
     * `sessions` is every live session the camper is on, dated, in date order —
     * which is what lets a caller say "arrives 13 July" rather than just "not
     * yet".
     */
    W.presenceOf = function (o) {
        o = o || {};
        var name = String(o.camperName == null ? '' : o.camperName);
        var on = ymd(o.on) || W.today();
        var sessions = Array.isArray(o.sessions) ? o.sessions : [];
        var enrollments = o.enrollments || {};
        var roster = o.roster || {};

        // A hand-unenrolled camper is out, whatever the calendar says. That flag
        // is a decision somebody made; a date is only a circumstance.
        var r = roster[name];
        if (r && r.unenrolled) {
            return { state: 'none', reason: 'unenrolled_by_office', session: '',
                     from: null, to: null, sessions: [] };
        }

        function sessionByName(n) {
            for (var i = 0; i < sessions.length; i++) {
                if (sessions[i] && sessions[i].name === n) return sessions[i];
            }
            return null;
        }

        var mine = [];
        Object.keys(enrollments).forEach(function (eid) {
            var e = enrollments[eid];
            if (!e || String(e.camperName) !== name) return;
            if (!W.LIVE_STATUS[String(e.status)]) return;
            var w = W.sessionWindow(sessionByName(e.session));
            mine.push({ id: eid, session: e.session || '', from: w.from, to: w.to,
                        unusable: !!w.unusable });
        });

        if (!mine.length) {
            return { state: 'none', reason: 'no_live_enrollment', session: '',
                     from: null, to: null, sessions: [] };
        }

        // Undated first, then by start date: an undated session is the one that
        // makes the camper unconditionally present, so it should be the answer.
        mine.sort(function (a, b) {
            if (!a.from && b.from) return -1;
            if (a.from && !b.from) return 1;
            return String(a.from || '').localeCompare(String(b.from || ''));
        });

        // ONE SPAN, not a set of windows. A camper's stay runs from the earliest
        // start to the latest end of everything they are on, and the date is
        // tested against THAT.
        //
        // The difference shows up on the changeover: a camp's two halves have a
        // day or two between them, and per-session coverage would make a child
        // enrolled in BOTH halves vanish from the roster — and their family lose
        // the portal — for those two days. They are the camp's camper for the
        // whole summer; the gap is not a departure.
        var undated = mine.filter(function (m) { return !m.from && !m.to; });
        if (undated.length) {
            return { state: 'active',
                     reason: undated[0].unusable ? 'dates_unusable' : 'session_has_no_dates',
                     session: undated[0].session, from: null, to: null, sessions: mine };
        }
        // An open-ended side stays open: one session with no start means the
        // stay has no start.
        var openStart = mine.some(function (m) { return !m.from; });
        var openEnd = mine.some(function (m) { return !m.to; });
        var starts = mine.filter(function (m) { return m.from; }).map(function (m) { return m.from; }).sort();
        var ends = mine.filter(function (m) { return m.to; }).map(function (m) { return m.to; }).sort();
        var spanFrom = openStart ? null : starts[0];
        var spanTo = openEnd ? null : ends[ends.length - 1];

        if ((!spanFrom || on >= spanFrom) && (!spanTo || on <= spanTo)) {
            // Inside the stay. Name the session that actually covers today when
            // one does, so a both-halves camper reads as "2nd Half" in August
            // rather than "1st Half" for the whole summer.
            var covering = null;
            for (var i = 0; i < mine.length; i++) {
                var m = mine[i];
                if ((!m.from || on >= m.from) && (!m.to || on <= m.to)) { covering = m; break; }
            }
            return { state: 'active', reason: covering ? 'in_session' : 'between_sessions',
                     session: (covering || mine[0]).session,
                     from: (covering || mine[0]).from, to: (covering || mine[0]).to,
                     sessions: mine };
        }
        if (spanFrom && on < spanFrom) {
            var first = mine.filter(function (m) { return m.from === spanFrom; })[0] || mine[0];
            return { state: 'upcoming', reason: 'session_not_started',
                     session: first.session, from: first.from, to: first.to, sessions: mine };
        }
        var last = mine.filter(function (m) { return m.to === spanTo; })[0] || mine[mine.length - 1];
        return { state: 'ended', reason: 'session_finished',
                 session: last.session, from: last.from, to: last.to, sessions: mine };
    };

    /**
     * Everybody's state at once.
     *
     * Returns { byCamper: {name: presence}, active:[names], upcoming:[names],
     *           ended:[names], none:[names] }.
     */
    W.presenceFor = function (o) {
        o = o || {};
        var names = Array.isArray(o.camperNames) ? o.camperNames : [];
        var out = { byCamper: {}, active: [], upcoming: [], ended: [], none: [] };
        names.forEach(function (n) {
            var p = W.presenceOf({
                camperName: n, enrollments: o.enrollments, sessions: o.sessions,
                roster: o.roster, on: o.on
            });
            out.byCamper[n] = p;
            out[p.state].push(n);
        });
        return out;
    };

    /**
     * What Link should give this family.
     *
     * 'full'          at least one child is at camp today.
     * 'payments_only' they have children, none of them at camp today. The
     *                 portal stays OPEN on the bill, because a second-half
     *                 family in June has a deposit schedule to look at and
     *                 nothing else — and because shutting them out entirely is
     *                 what made migration 039 revert this idea the first time.
     * 'none'          no children at all. Nothing to show.
     */
    W.linkAccessFor = function (presence) {
        var p = presence || {};
        if ((p.active || []).length) return 'full';
        if ((p.upcoming || []).length || (p.ended || []).length) return 'payments_only';
        return 'none';
    };

    /** A line an office — or a parent — can read. */
    W.explain = function (p, o) {
        o = o || {};
        var name = o.name || 'This camper';
        if (!p) return '';
        if (p.state === 'active') return name + ' is at camp' + (p.session ? ' — ' + p.session : '');
        if (p.state === 'upcoming') {
            return name + ' has not started yet' +
                   (p.session ? ' — ' + p.session : '') +
                   (p.from ? ', from ' + p.from : '');
        }
        if (p.state === 'ended') {
            return name + '’s session has finished' +
                   (p.to ? ' — ended ' + p.to : '');
        }
        return p.reason === 'unenrolled_by_office'
            ? name + ' has been unenrolled'
            : name + ' is not enrolled';
    };

    /**
     * The sessions a roster view can be filtered by, newest-dated last, plus
     * the pseudo-entries every such picker needs.
     *
     * `value` is what a caller stores; 'today' means "whoever is here now",
     * which is the only honest default for a page an office opens in July.
     */
    W.pickerOptions = function (sessions, o) {
        o = o || {};
        var today = ymd(o.on) || W.today();
        var opts = [
            { value: 'today', label: 'In camp today', on: today },
            { value: 'all', label: 'Everyone enrolled', on: null }
        ];
        (Array.isArray(sessions) ? sessions : []).slice()
            .sort(function (a, b) {
                return String(W.sessionWindow(a).from || '')
                    .localeCompare(String(W.sessionWindow(b).from || ''));
            })
            .forEach(function (s) {
                if (!s || !s.name) return;
                var w = W.sessionWindow(s);
                opts.push({
                    value: 'session:' + s.name, label: s.name, session: s.name,
                    // Filtering BY a session means "who is on it", not "who is
                    // there on some day in it" — a camper on the other half is
                    // not on this session even if the dates happen to overlap.
                    on: w.from, from: w.from, to: w.to
                });
            });
        return opts;
    };

    /**
     * Apply a picker choice to a list of camper names.
     *
     * 'all' is everyone with a live enrollment (or on the roster, for a camp
     * that keeps campers without enrollment records). 'today' is presence now.
     * 'session:X' is membership of X, which is a different question from
     * presence and has to be asked separately.
     */
    W.filterNames = function (choice, o) {
        o = o || {};
        var names = Array.isArray(o.camperNames) ? o.camperNames : [];
        var pick = String(choice || 'today');

        if (pick === 'all') return names.slice();

        if (pick.indexOf('session:') === 0) {
            var want = pick.slice('session:'.length);
            var enrollments = o.enrollments || {};
            var keep = {};
            Object.keys(enrollments).forEach(function (eid) {
                var e = enrollments[eid];
                if (!e || !W.LIVE_STATUS[String(e.status)]) return;
                if (String(e.session) !== want) return;
                keep[String(e.camperName)] = 1;
            });
            return names.filter(function (n) { return !!keep[n]; });
        }

        var pres = W.presenceFor({
            camperNames: names, enrollments: o.enrollments,
            sessions: o.sessions, roster: o.roster, on: o.on
        });
        return pres.active.slice();
    };

    if (typeof root !== 'undefined' && root) root.CampistryEnrollmentWindow = W;
    if (typeof module !== 'undefined' && module.exports) module.exports = W;
})(typeof window !== 'undefined' ? window : null);
