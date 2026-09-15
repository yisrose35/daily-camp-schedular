// =============================================================================
// campistry_control_matrix.js — entitlement <-> checkbox encoding
//
// The three pure functions behind the matrix on campistry_control.html, kept
// out of the page so they can be tested. They shipped a wrong answer once and
// it was the worst kind: the page showed every camp with NOTHING ticked when in
// fact every camp had EVERYTHING, because '{}' was read as "bought nothing"
// rather than "unrestricted". Saving from that screen without touching a box
// would have switched the camp off.
//
// THE CONTRACT, in one line: a tick means "this camp has it".
//
// Two representations, and the difference only shows up in the future:
//
//   '{}'                     unrestricted — has everything, INCLUDING apps and
//                            sections added after today
//   { "me": "*" }            has all of Me as it exists whenever it is read
//   { "me": ["campers"] }    has exactly those sections; an app that is absent
//                            from a NON-EMPTY object was not bought
//
// So "everything ticked" must round-trip to '{}' and not to an explicit list of
// every app: the explicit list freezes the camp at today's catalogue and would
// silently withhold every new feature from a camp paying for everything.
//
// CAPS is passed in rather than read off window, so a test can drive these
// against the real registry without a browser.
// =============================================================================
(function () {
    'use strict';

    var M = {};

    /** Entitlement object -> { app: { section: boolean } }. */
    M.draftFrom = function (CAPS, ent) {
        var unrestricted = !ent || typeof ent !== 'object' || Object.keys(ent).length === 0;
        var d = {};
        CAPS.APPS.forEach(function (app) {
            var has = !unrestricted && Object.prototype.hasOwnProperty.call(ent, app.key);
            var v = has ? ent[app.key] : undefined;
            d[app.key] = {};
            CAPS.forApp(app.key).forEach(function (cap) {
                d[app.key][cap.section] =
                    unrestricted ? true :
                    (v === '*') ? true :
                    (Array.isArray(v) ? v.indexOf(cap.section) >= 0 : false);
            });
        });
        return d;
    };

    /** Is every section of every app ticked? */
    M.isEverything = function (CAPS, draft) {
        return CAPS.APPS.every(function (app) {
            var secs = CAPS.forApp(app.key);
            if (!secs.length) return true;              // nothing to tick
            return secs.every(function (c) { return draft[app.key] && draft[app.key][c.section]; });
        });
    };

    /** { app: { section: boolean } } -> entitlement object. */
    M.entFrom = function (CAPS, draft) {
        if (M.isEverything(CAPS, draft)) return {};    // see the header
        var ent = {};
        CAPS.APPS.forEach(function (app) {
            var secs = CAPS.forApp(app.key);
            var on = secs.filter(function (c) { return draft[app.key] && draft[app.key][c.section]; });
            if (on.length === 0) return;                            // app not bought
            if (on.length === secs.length) { ent[app.key] = '*'; return; }
            ent[app.key] = on.map(function (c) { return c.section; });
        });
        return ent;
    };

    if (typeof window !== 'undefined') window.CampistryControlMatrix = M;
    if (typeof module !== 'undefined' && module.exports) module.exports = M;
})();
