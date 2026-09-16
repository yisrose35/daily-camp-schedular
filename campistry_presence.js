/* =============================================================================
 * campistry_presence.js — "is this camper actually here today?", answerable from
 * anywhere in the app in one line.
 *
 * WHY A SECOND FILE. campistry_enrollment_window.js is the RULE and is pure: you
 * hand it enrollments, sessions and a date, and it tells you who is present. That
 * is the right shape for the rule and the wrong shape for a caller, because the
 * dozen places that enumerate campers — the bunk generator, the print sheets, the
 * allergy list, attendance, the canteen till, the bus lists, the counsellor app,
 * badges, birthdays — are separate scripts on different pages, and most of them
 * have never heard of `enrollments` or `sessions`. Asking each of them to go and
 * find that state would mean a dozen copies of the same lookup, which is a dozen
 * chances to disagree about who is at camp.
 *
 * So this is the ONE place that knows where the state lives. It resolves
 * enrollments, sessions and the roster once, caches them for the length of a
 * render, and exposes the rule as `isHere(name)`.
 *
 * THE SAFETY PROPERTY, WHICH IS THE WHOLE DESIGN: IF WE CANNOT TELL, EVERYONE IS
 * HERE. No settings blob, no sessions, no dates on the sessions, a parse error, a
 * page that never loaded the rule module — every one of those answers "present".
 * Dropping a camper from a bunk list because localStorage happened to be cold is
 * a child nobody counted at pickup. Showing one extra name is a name somebody
 * crosses off. The costs are not comparable and the defaults follow that.
 *
 * WHAT THIS IS NOT. It is not a gate on anything a parent sees — that is
 * migration 191, server-side, because a client-side gate is not a gate. This is
 * for the camp's own lists, where the question is not "may you see this" but "is
 * this person in front of me".
 * ========================================================================== */
(function (root) {
    'use strict';
    var P = {};

    /** The rule. Absent on a page that did not load it — see hasRule(). */
    function W() {
        return (typeof root !== 'undefined' && root && root.CampistryEnrollmentWindow) || null;
    }
    P.hasRule = function () { return !!W(); };

    // ── where the state lives ──────────────────────────────────────────────
    // Cached, because a bunk list asks this once per camper and re-reading and
    // re-parsing the settings blob a few hundred times per render is the kind of
    // thing that makes a page feel broken.
    var _cache = null, _cacheAt = 0, _provided = null;
    var CACHE_MS = 4000;

    function readState() {
        var out = { roster: {}, enrollments: {}, sessions: [], ok: false };
        // Injected state wins: a page that handed it over knows better than a
        // snapshot of somebody else's idea of the same camp.
        if (_provided) return _provided;
        try {
            // The Me page has the live objects in its own scope and hands them
            // over; every other page reads the blob the app already syncs.
            if (typeof root.CampistryPresenceState === 'function') {
                var live = root.CampistryPresenceState() || {};
                out.roster = live.roster || {};
                out.enrollments = live.enrollments || {};
                out.sessions = Array.isArray(live.sessions) ? live.sessions : [];
                out.ok = true;
                return out;
            }
            if (typeof root.loadGlobalSettings === 'function') {
                var all = root.loadGlobalSettings() || {};
                var me = all.campistryMe || root.loadGlobalSettings('campistryMe') || {};
                // The roster lives in TWO places depending on the page. Me keeps
                // it at campistryMe.roster; every other page in the app reads
                // app1.camperRoster. Only the `unenrolled` flags are wanted from
                // it, so either will do and both are merged.
                out.roster = Object.assign({},
                    (all.app1 && all.app1.camperRoster) || {}, me.roster || {});
                out.enrollments = me.enrollments || {};
                out.sessions = Array.isArray(me.sessions) ? me.sessions : [];

                // COLD START. integration_hooks strips campistryMe.enrollments
                // (and app1.camperRoster) out of the localStorage snapshot,
                // because both grow without bound with camp size and the ~5MB
                // ceiling would drop the whole write. The full state lives in
                // IndexedDB, so a warm page has the real objects — but a cold one
                // has only the snapshot, and would gate nobody.
                //
                // So the snapshot also carries a COMPACT INDEX: per camper, the
                // spans of the sessions they are on and nothing else. It is
                // rebuilt on every snapshot write from the full state, so it
                // cannot drift the way migration 035's stamped windows did, and
                // it is a few tens of kilobytes where enrollments are megabytes.
                //
                // Synthesized back into enrollments + sessions rather than
                // interpreted here, so presenceOf stays the one rule that decides.
                if (!Object.keys(out.enrollments).length && me.presenceIndex) {
                    var idx = me.presenceIndex, ses = {}, n = 0;
                    Object.keys(idx).forEach(function (name) {
                        (idx[name] || []).forEach(function (sp, i) {
                            var key = String(sp.s || ('span' + i));
                            ses[key] = { name: key, startDate: sp.f || '', endDate: sp.t || '' };
                            out.enrollments['px_' + (++n)] =
                                { camperName: name, session: key, status: 'enrolled' };
                        });
                    });
                    out.sessions = Object.keys(ses).map(function (k) { return ses[k]; });
                }

                // `ok` means a document with something in it. An empty one is
                // indistinguishable from a cold cache, and both must mean "do
                // not gate".
                out.ok = !!(Object.keys(out.enrollments).length && out.sessions.length);
                return out;
            }
        } catch (e) {
            // Deliberately silent beyond a warning: a broken blob must degrade to
            // "everyone is here", never to an exception in a print routine.
            if (root.console && root.console.warn) {
                root.console.warn('[Presence] could not read camp state:', e && e.message);
            }
        }
        return out;
    }

    function state() {
        var now = Date.now();
        if (_cache && (now - _cacheAt) < CACHE_MS) return _cache;
        _cache = readState();
        _cacheAt = now;
        return _cache;
    }

    /** Drop the cache. Call after anything that changes enrollments or sessions. */
    P.refresh = function () { _cache = null; _cacheAt = 0; return P; };

    /**
     * Hand the state in directly.
     *
     * For pages that already hold it and did not get it from loadGlobalSettings —
     * the counsellor app loads its own from Supabase, the badges widget reads two
     * keys straight out of camp_state_kv, the birthday card is handed a settings
     * object by its caller. Injecting it keeps ONE idiom (`isHere(name)`) across
     * every surface instead of each page re-deriving presence its own way.
     *
     * Passing nothing clears the injection and goes back to reading the blob.
     */
    P.provide = function (st) {
        if (!st) { _provided = null; return P.refresh(); }
        _provided = {
            roster: st.roster || {},
            enrollments: st.enrollments || {},
            sessions: Array.isArray(st.sessions) ? st.sessions : [],
            ok: !!(st.enrollments && Object.keys(st.enrollments).length &&
                   Array.isArray(st.sessions) && st.sessions.length)
        };
        return P.refresh();
    };

    /**
     * Is presence even a question at this camp?
     *
     * False when no session carries dates — a camp that has not filled them in,
     * or one that runs a single undated summer. Callers use this to decide
     * whether to show a session picker at all, and MUST NOT use it to decide
     * whether to filter: filtering is already a no-op in that case, because the
     * rule reads an undated session as always-open.
     */
    P.hasDates = function () {
        var w = W(); if (!w) return false;
        var s = state();
        if (!s.ok) return false;
        for (var i = 0; i < s.sessions.length; i++) {
            var win = w.sessionWindow(s.sessions[i]);
            if (win.from || win.to) return true;
        }
        return false;
    };

    /** Today, in the app's own date format. */
    P.today = function () {
        var w = W();
        if (w) return w.today();
        var d = new Date();
        return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    };

    /**
     * The full verdict for one camper: {state, reason, session, from, to}.
     *
     * Returns an `active` verdict whenever it cannot tell, with a reason that
     * says so, so a caller logging this can see the difference between "at camp"
     * and "we have no idea".
     */
    P.stateOf = function (name, on) {
        var w = W();
        if (!w) return { state: 'active', reason: 'rule_not_loaded', session: '', from: null, to: null };
        var s = state();
        if (!s.ok) return { state: 'active', reason: 'no_camp_state', session: '', from: null, to: null };
        return w.presenceOf({
            camperName: name, enrollments: s.enrollments, sessions: s.sessions,
            roster: s.roster, on: on || P.today()
        });
    };

    /** Is this camper at camp on `on` (default today)? */
    P.isHere = function (name, on) {
        return P.stateOf(name, on).state === 'active';
    };

    /**
     * Keep only the campers who are here. Accepts an array of names, or an array
     * of [name, data] pairs the way Object.entries() produces — the shape half
     * this app's lists are already in.
     */
    P.filter = function (list, on) {
        if (!Array.isArray(list)) return list;
        var day = on || P.today();
        return list.filter(function (item) {
            var name = Array.isArray(item) ? item[0] : item;
            return P.isHere(name, day);
        });
    };

    /** Who is NOT here, and why — for the "3 not in this slice" notices. */
    P.absent = function (list, on) {
        if (!Array.isArray(list)) return [];
        var day = on || P.today();
        var out = [];
        list.forEach(function (item) {
            var name = Array.isArray(item) ? item[0] : item;
            var p = P.stateOf(name, day);
            if (p.state !== 'active') out.push({ name: name, presence: p });
        });
        return out;
    };

    /**
     * A short line for a list header: "42 in camp today · 8 not yet arrived".
     * Empty when there is nothing worth saying, so a caller can concatenate it
     * unconditionally.
     */
    P.summary = function (list, on) {
        if (!P.hasDates()) return '';
        var absent = P.absent(list, on);
        if (!absent.length) return '';
        var up = absent.filter(function (a) { return a.presence.state === 'upcoming'; }).length;
        var done = absent.filter(function (a) { return a.presence.state === 'ended'; }).length;
        var bits = [];
        if (up) bits.push(up + ' not arrived yet');
        if (done) bits.push(done + ' already finished');
        var other = absent.length - up - done;
        if (other) bits.push(other + ' not enrolled');
        return bits.join(' · ');
    };

    if (typeof root !== 'undefined' && root) root.CampistryPresence = P;
    if (typeof module !== 'undefined' && module.exports) module.exports = P;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
