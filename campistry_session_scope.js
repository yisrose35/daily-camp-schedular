/* =============================================================================
 * campistry_session_scope.js — WHICH SESSION IS THE PROGRAM SHOWING?
 *
 * THE PROBLEM. A camp runs 1st Half and 2nd Half. Every list in the app answers
 * "who is here" — the roster, the bunk sheets, Live's attendance, the canteen till,
 * Health's medication list, Go's bus manifests, the print centre. Until now each of
 * them answered it for TODAY, and only a planning sandbox could be pointed at a
 * different session. So an office in late June preparing 2nd Half had no way to say
 * so: they either looked at 1st Half's children and manually ignored them, or they
 * built a sandbox, which is a heavier thing than "show me the other half".
 *
 * Worse, the one page that DID have a session picker (the camper roster) kept its
 * choice in a page variable. Navigate away and it forgot. Open a second tab and the
 * two disagreed. Nothing else on any page knew the choice had been made at all.
 *
 * ── THE MASTER KEY ─────────────────────────────────────────────────────────
 *
 * One camp-wide answer, set on the dashboard, that every page reads. Its default is
 * NOT a stored value: it is DERIVED from the camp's dates — whichever session today
 * falls in. That is the same principle that made us delete migrations 035/039's
 * stamped date windows: a derived answer cannot drift, and a stored one always
 * eventually does.
 *
 * An owner may PIN a session when derivation is not what they want ("we are all
 * working on 2nd Half now, even though 1st Half is still running"), and the whole
 * program follows.
 *
 * There was briefly a per-person "peek" as well, reachable only from a bar this file
 * put on top of every page. The bar was noise and is gone, and the peek went with it
 * rather than staying as an API nothing can call — which is the exact shape of
 * defect this codebase keeps turning up. The per-page roster picker still does that
 * job where it is actually wanted, without leaking across pages.
 *
 * ── A PIN IS HONOURED WHATEVER THE DATES SAY ───────────────────────────────
 *
 * This file first refused a pin to a session that had ENDED, on the grounds that
 * somebody pins 1st Half in June, forgets, and in August the office is working
 * against a roster that finished five weeks ago.
 *
 * That was wrong, and it broke the two times of year a camp most needs this:
 *
 *   BEFORE THE SUMMER  nothing covers today, so the calendar has no answer and every
 *                      list shows everyone. Pinning 1st Half in May is how an office
 *                      gets set up. (This half always worked — a pin forward was
 *                      allowed.)
 *   AFTER A SESSION    "we are finished with 1st Half, let us tidy it up" is ordinary
 *                      work, and it is exactly what the refusal made impossible. In
 *                      September a camp could not scope to 2nd Half at all.
 *
 * The dates of a session say nothing about whether somebody MEANT to pin it. Refusing
 * a deliberate choice to guard against a forgotten one is the wrong trade, so a pin
 * now applies for as long as it is set, and the app says plainly when the pinned
 * session is not the one running today (`outOfSeason`, and outOfSeasonNotice below).
 *
 * A pin is still dropped in one case: when it names a session that no longer exists,
 * because there is then nothing to show at all.
 *
 * ── PRECEDENCE, MOST SPECIFIC FIRST ────────────────────────────────────────
 *
 *   workspace   you are inside a planning sandbox built for a session. Already
 *               stated in the amber bar, and the most specific reality there is.
 *   pin         the camp-wide pin, whatever its dates.
 *   calendar    the session today falls in. The normal answer.
 *   only        the camp has exactly one session, so there was never a choice.
 *   none        no sessions, or today falls between them. NOTHING is scoped, and
 *               the app behaves exactly as it did before this file existed.
 *
 * ── AND THE DATE, WHICH IS THE PART THAT ACTUALLY DOES THE WORK ────────────
 *
 * Scoping to a session does not copy or filter anything. It moves the DATE the live
 * roster is read at: 2nd Half's roster is the live roster as of 2nd Half's first
 * day. Nothing is duplicated, nothing can drift, and every list that already asks
 * "who is here on this date" gets the right answer without knowing this file exists.
 *
 * When the scoped session covers today, the date IS today — you are in it, and
 * today's roster is the right one.
 *
 * Pure. It resolves and describes; it reads no storage and writes nothing.
 * ========================================================================== */
(function (root) {
    'use strict';
    var S = {};

    function str(s) { return String(s == null ? '' : s).trim(); }
    function ymd(d) { return str(d).slice(0, 10); }
    function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

    /** Every way the answer can have been arrived at, and what each one means. */
    S.SOURCES = {
        workspace: 'A planning sandbox built for this session',
        pin:       'The camp is pinned to this session',
        calendar:  'The session running today',
        only:      'The camp’s only session',
        none:      'No session — showing everyone, as of today'
    };

    /** Today, in the app's own date strings. Callers may override it. */
    S.today = function (now) {
        var d = (now instanceof Date) ? now : new Date();
        return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
            .toISOString().slice(0, 10);
    };

    /**
     * The enrollment-window rule, which already owns "what dates does this session
     * cover". Injectable for the same reason every other rule here is: this file is
     * a global in the browser and a require() in tests.
     *
     * Its absence is not fatal — the fallback below reads startDate/endDate the same
     * way — but the rule is preferred so there is one answer to the question,
     * including its handling of a start date after an end date.
     */
    var _win = null;
    S.useWindowRule = function (W) { _win = W || null; return S; };
    function windowRule(given) {
        if (given && typeof given.sessionWindow === 'function') return given;
        if (_win && typeof _win.sessionWindow === 'function') return _win;
        try {
            var W = (typeof root !== 'undefined' && root && root.CampistryEnrollmentWindow) || null;
            if (W && typeof W.sessionWindow === 'function') return W;
        } catch (e) {}
        return null;
    }

    /** {from, to} for one session, via the rule when it is loaded. */
    S.windowOf = function (session, rule) {
        var W = windowRule(rule);
        if (W) return W.sessionWindow(session);
        if (!session || typeof session !== 'object') return { from: null, to: null };
        var a = ymd(session.startDate), b = ymd(session.endDate);
        var from = isDate(a) ? a : null, to = isDate(b) ? b : null;
        // A start after an end is a typo, not a window. Same call the rule makes.
        if (from && to && from > to) return { from: null, to: null, unusable: true };
        return { from: from, to: to };
    };

    /** Does this session cover `on`? An undated session covers everything. */
    S.covers = function (session, on, rule) {
        var w = S.windowOf(session, rule);
        var day = ymd(on);
        if (!isDate(day)) return true;
        if (w.from && day < w.from) return false;
        if (w.to && day > w.to) return false;
        return true;
    };

    function find(sessions, name) {
        var want = str(name);
        if (!want) return null;
        return (Array.isArray(sessions) ? sessions : []).filter(function (s) {
            return s && str(s.name) === want;
        })[0] || null;
    }

    /** Sessions in date order, undated last. The order a picker should show. */
    S.ordered = function (sessions, rule) {
        return (Array.isArray(sessions) ? sessions : [])
            .filter(function (s) { return s && str(s.name); })
            .map(function (s, i) { return { s: s, i: i, w: S.windowOf(s, rule) }; })
            .sort(function (a, b) {
                // Undated sorts last: a session with no dates is not evidence of
                // being the earliest, and putting it first would make it the
                // calendar's answer for a camp that simply has not filled in dates.
                if (!a.w.from !== !b.w.from) return a.w.from ? -1 : 1;
                if (a.w.from && b.w.from && a.w.from !== b.w.from) {
                    return a.w.from < b.w.from ? -1 : 1;
                }
                return a.i - b.i;
            })
            .map(function (x) { return x.s; });
    };

    /**
     * Which session the calendar says we are in. '' when it cannot tell.
     *
     * Only a DATED session can be the calendar's answer. An undated one covers every
     * day, so treating it as today's session would make a camp that has not entered
     * any dates permanently "in" whichever session was typed first — an answer that
     * looks authoritative and means nothing.
     */
    S.calendarSession = function (sessions, on, rule) {
        var day = ymd(on) || S.today();
        var hit = S.ordered(sessions, rule).filter(function (s) {
            var w = S.windowOf(s, rule);
            if (!w.from && !w.to) return false;
            return S.covers(s, day, rule);
        })[0];
        return hit ? str(hit.name) : '';
    };

    /**
     * Is this session the one running on `on`? Reported, never enforced.
     *
     * A pin to a session that is over is a normal thing to want — tidying up 1st Half
     * in August, closing out the summer in September — so nothing here refuses it.
     * What this answers is whether to SAY so, which is a different job.
     *
     * Its own function rather than inlined because the picker, the resolver and the
     * notice all need the same answer, and three copies of a date comparison is three
     * chances to disagree about the last day of a session.
     */
    S.isCurrent = function (session, on, rule) {
        return S.covers(session, ymd(on) || S.today(), rule);
    };
    /** Has this session finished? Used for wording, never for refusing. */
    S.hasEnded = function (session, on, rule) {
        var w = S.windowOf(session, rule);
        var day = ymd(on) || S.today();
        if (!w.to) return false;          // an undated session never ends
        return day > w.to;
    };

    /**
     * THE MASTER KEY.
     *
     * o = {
     *   sessions:         [{name, startDate, endDate}],
     *   pin:              camp-wide pinned session name, or '' for automatic
     *   workspaceSession: the session a planning sandbox is built for, or ''
     *   today:            override for testing
     *   windowRule:       override for testing
     * }
     *
     * Returns everything a caller could need, so nobody has to re-derive any of it:
     *
     *   { session, on, source, sessionObj, from, to, coversToday,
     *     pin, pinDropped, droppedPin, outOfSeason, ended, label, detail }
     *
     * `outOfSeason` is true when the session being shown is not the one running
     * today — pinned ahead, or pinned to one that is over. It is information for the
     * UI, never a refusal.
     */
    S.resolve = function (o) {
        o = o || {};
        var rule = o.windowRule || null;
        var sessions = Array.isArray(o.sessions) ? o.sessions : [];
        var today = ymd(o.today) || S.today();
        var out = {
            session: '', on: today, source: 'none', sessionObj: null,
            from: null, to: null, coversToday: true,
            pin: str(o.pin), pinDropped: false, droppedPin: '',
            outOfSeason: false, ended: false,
            label: '', detail: ''
        };

        // 1. A sandbox built for a session. Most specific, and already shouted about
        //    by the amber planning bar, so nothing here may override it.
        var wsName = str(o.workspaceSession);
        if (wsName && find(sessions, wsName)) {
            return decorate(out, 'workspace', find(sessions, wsName), today, rule);
        }

        // 2. The camp-wide pin, if it is still meaningful.
        var pinObj = find(sessions, out.pin);
        if (out.pin && !pinObj) {
            // Pinned to a session somebody has since deleted or renamed. There is
            // nothing to show, so fall through to the calendar and say so.
            out.pinDropped = true;
            out.droppedPin = out.pin;
        } else if (pinObj) {
            // HONOURED WHATEVER THE DATES SAY. See the header: before the summer and
            // after a session are the two times a camp most needs this, and both were
            // refused while a pin had to fall inside its own window.
            return decorate(out, 'pin', pinObj, today, rule);
        }

        // 3. Whatever is running today.
        var calName = S.calendarSession(sessions, today, rule);
        if (calName) return decorate(out, 'calendar', find(sessions, calName), today, rule);

        // 4. Exactly one session: there was never a choice to make.
        var named = sessions.filter(function (s) { return s && str(s.name); });
        if (named.length === 1) return decorate(out, 'only', named[0], today, rule);

        // 5. Nothing to scope by. The app behaves exactly as it did before.
        return decorate(out, 'none', null, today, rule);
    };

    function decorate(out, source, sessionObj, today, rule) {
        out.source = source;
        out.sessionObj = sessionObj || null;
        out.session = sessionObj ? str(sessionObj.name) : '';

        if (!sessionObj) {
            out.on = today;
            out.coversToday = true;
            out.from = out.to = null;
            out.label = 'Everyone, as of today';
            out.detail = S.SOURCES.none;
            return out;
        }

        var w = S.windowOf(sessionObj, rule);
        out.from = w.from || null;
        out.to = w.to || null;
        out.coversToday = S.covers(sessionObj, today, rule);
        // THE DATE IS THE WHOLE MECHANISM. In the session, today is the honest date.
        // Outside it, read the live roster as of the session's first day — which is
        // what makes "show me 2nd Half" work without copying a roster.
        out.on = out.coversToday ? today : (w.from || today);

        // SAID, NOT ENFORCED. A pinned session that is not today's is the whole point
        // of the pin; the UI needs to be able to state it so nobody has to work it out
        // from a roster that looks wrong.
        out.outOfSeason = !out.coversToday;
        out.ended = S.hasEnded(sessionObj, today, rule);
        out.label = out.session;
        out.detail = S.SOURCES[source] || '';
        return out;
    }

    /**
     * The dashboard picker. 'auto' first, and it NAMES what automatic currently
     * resolves to — "Follow the calendar" alone asks somebody to trust a black box,
     * and the commonest reason to reach for the pin is not believing it.
     */
    S.optionsFor = function (o) {
        o = o || {};
        var rule = o.windowRule || null;
        var today = ymd(o.today) || S.today();
        var cal = S.calendarSession(o.sessions, today, rule);
        var opts = [{
            value: 'auto',
            label: 'Follow the calendar' + (cal ? ' — ' + cal + ' now' : ''),
            auto: true, resolves: cal
        }];
        S.ordered(o.sessions, rule).forEach(function (s) {
            var w = S.windowOf(s, rule);
            opts.push({
                value: str(s.name), label: str(s.name), session: str(s.name),
                from: w.from || '', to: w.to || '',
                // The option reports its dates and whether it has finished. It does
                // NOT discourage: picking a session that is over is how you tidy it
                // up, and an option tagged as a mistake is an option nobody picks.
                ended: S.hasEnded(s, today, rule),
                current: S.isCurrent(s, today, rule)
            });
        });
        return opts;
    };

    /**
     * What to tell somebody when a pin was dropped. Shown on the dashboard card, and
     * it names the session that was dropped rather than saying "a session" — the
     * whole point is that somebody can act on it.
     */
    S.droppedNotice = function (r) {
        if (!r || !r.pinDropped) return '';
        var was = r.droppedPin || 'a session';
        return 'The camp was pinned to ' + was + ', which no longer exists. '
             + 'Everything is back to following the calendar'
             + (r.session ? ' — showing ' + r.session + '.' : '.');
    };

    /**
     * What to tell somebody working on a session that is not today's.
     *
     * Empty in the ordinary case, so this cannot become the banner everybody learns
     * to ignore. When it does appear it says which way round it is, because "2nd Half
     * has not started" and "1st Half is over" lead to completely different next
     * actions.
     */
    S.outOfSeasonNotice = function (r, fmt) {
        if (!r || !r.session || !r.outOfSeason) return '';
        // `fmt` lets the caller print the date the way the rest of its page does. The
        // WORDING stays here, because which way round this is — ahead or over — is
        // something only the rule knows; the caller only decides what a date looks
        // like. Without it the notice reads '2026-08-26' next to a dropdown saying
        // 'Aug 26', which is the kind of mismatch that makes a page feel unfinished.
        var d = (typeof fmt === 'function') ? fmt : function (x) { return String(x); };
        var when = r.ended
            ? (r.to ? 'ended on ' + d(r.to) : 'is over')
            : (r.from ? 'starts on ' + d(r.from) : 'has not started yet');
        return r.session + ' ' + when + '. Lists show the children on it'
             + (r.from ? ', as of ' + d(r.from) : '') + ', not the ones at camp today.';
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = S;
    if (root) root.CampistrySessionScope = S;
})(typeof window !== 'undefined' ? window : null);
