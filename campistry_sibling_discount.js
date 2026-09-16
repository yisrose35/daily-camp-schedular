/* =============================================================================
 * campistry_sibling_discount.js — which children are discounted, and by how
 * much, recomputed from the family as it is NOW.
 *
 * WHY THIS EXISTS. The sibling discount was applied in one place, once:
 *
 *     if (sesObj.siblingDiscount > 0 && families[famKey].camperIds.length > 0)
 *
 * Three things follow from "once, at enrollment, if the family already has
 * campers", and all three cost somebody money:
 *
 *   IT DEPENDED ON TYPING ORDER. The first child entered got nothing; the
 *     second got the discount. Enter the same two children the other way round
 *     and a different child is discounted — and if their sessions cost
 *     different amounts, the family pays a different total for the same two
 *     children.
 *
 *   IT WAS NEVER RE-CHECKED. If the discounted sibling withdrew, the one left
 *     kept a discount whose condition no longer held. If the UNdiscounted one
 *     was left, the camp went on billing full price for a discount it owed.
 *     This is the failure the industry writes about: "discount codes break when
 *     enrollment changes, such as when a second child drops mid-season".
 *
 *   THE PUBLIC FORM DID NOT APPLY IT AT ALL. campistry_register.html had
 *     `var sibDiscount = siblings.length * 0;` — multiplied by zero, deferring
 *     to a promo code. A family registering two children themselves paid full
 *     price for both and had to notice and ask.
 *
 * THE RULE HERE. Every enrolled camper except the most expensive one is
 * discounted, at their own session's rate. Most expensive rather than first
 * entered, because it is the only choice that does not depend on the order
 * somebody typed names in, and it is the one that favours the family.
 *
 * Pure: it reads enrollments and sessions and returns what each enrollment's
 * discount SHOULD be. It never posts and never mutates. The caller compares
 * with what is on the ledger and posts the difference, because tuition is
 * already a posted charge and posted charges are not edited.
 * ========================================================================== */
(function (root) {
    'use strict';
    var S = {};

    function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
    function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

    // An enrollment only counts towards, and only receives, a sibling discount
    // while it is live. A withdrawn camper is not a sibling for pricing.
    S.COUNTS = { enrolled: 1, accepted: 1 };

    /**
     * What every enrollment in this family should be discounted by.
     *
     * o = {
     *   enrollments: { id: {camperName, session, status, sessionTuition, discount} },
     *   sessions:    [ {name, tuition, siblingDiscount} ],
     *   camperNames: ['Eli','Mia']   // who belongs to this family
     * }
     *
     * Returns { byEnrollment: {id: {pct, amt, tuition, reason}}, discounted, counted }.
     * An enrollment that should have NO discount appears with pct 0 / amt 0, so
     * the caller can tell "should be zero" from "not considered" — which is how
     * a revoked discount gets noticed at all.
     */
    S.compute = function (o) {
        o = o || {};
        var enrollments = o.enrollments || {};
        var sessions = Array.isArray(o.sessions) ? o.sessions : [];
        var names = Array.isArray(o.camperNames) ? o.camperNames : [];
        var nameSet = {};
        names.forEach(function (n) { nameSet[String(n)] = 1; });

        function sessionOf(name) {
            for (var i = 0; i < sessions.length; i++) {
                if (sessions[i] && sessions[i].name === name) return sessions[i];
            }
            return null;
        }

        // Every live enrollment belonging to this family, with the tuition it
        // is priced from. Live tuition wins over the snapshot, the same rule
        // the rest of the app uses.
        var live = [];
        Object.keys(enrollments).forEach(function (eid) {
            var e = enrollments[eid];
            if (!e || !S.COUNTS[String(e.status)]) return;
            if (names.length && !nameSet[String(e.camperName)]) return;
            var ses = sessionOf(e.session);
            var liveT = ses && ses.tuition != null ? num(ses.tuition) : 0;
            var tuition = liveT > 0 ? liveT : num(e.sessionTuition);
            live.push({
                id: eid, camperName: e.camperName, tuition: round2(tuition),
                pct: ses ? Math.max(0, num(ses.siblingDiscount)) : 0
            });
        });

        var byEnrollment = {};
        if (live.length <= 1) {
            // One child is not a sibling set. Say so explicitly for the single
            // remaining child after a withdrawal — that is the case where a
            // stale discount has to be taken back.
            live.forEach(function (r) {
                byEnrollment[r.id] = { pct: 0, amt: 0, tuition: r.tuition, reason: 'only_camper' };
            });
            return { byEnrollment: byEnrollment, discounted: 0, counted: live.length };
        }

        // The most expensive enrollment pays full price. Ties broken by
        // enrollment id so the answer is stable across runs — an unstable
        // tie-break would move the discount between two identically priced
        // children every time anything was recalculated.
        var full = live.slice().sort(function (a, b) {
            return (b.tuition - a.tuition) || String(a.id).localeCompare(String(b.id));
        })[0];

        var discounted = 0;
        live.forEach(function (r) {
            if (r.id === full.id) {
                byEnrollment[r.id] = { pct: 0, amt: 0, tuition: r.tuition, reason: 'highest_tuition' };
                return;
            }
            var amt = r.pct > 0 ? round2(r.tuition * r.pct / 100) : 0;
            if (amt > 0) discounted++;
            byEnrollment[r.id] = {
                pct: r.pct, amt: amt, tuition: r.tuition,
                reason: amt > 0 ? 'sibling' : 'no_rate_on_session'
            };
        });
        return { byEnrollment: byEnrollment, discounted: discounted, counted: live.length };
    };

    /**
     * What changed, comparing what SHOULD be discounted with what each
     * enrollment currently carries.
     *
     * Returns a list of { enrollmentId, camperName, was, now, delta, direction }.
     * delta is what the family's balance must move by: POSITIVE means they owe
     * more (a discount was revoked), negative means they owe less.
     *
     * The caller posts that as a ledger entry rather than editing the tuition
     * charge, because a posted charge is a fact and facts are not rewritten.
     */
    S.diff = function (computed, enrollments) {
        var out = [];
        var by = (computed && computed.byEnrollment) || {};
        Object.keys(by).forEach(function (eid) {
            var e = (enrollments || {})[eid] || {};
            var was = round2(num(e.discount && e.discount.amt));
            var now = round2(by[eid].amt);
            if (Math.abs(was - now) < 0.005) return;
            out.push({
                enrollmentId: eid,
                camperName: e.camperName || '',
                was: was, now: now,
                delta: round2(was - now),        // + = owes more now
                direction: now > was ? 'more_discount' : 'less_discount',
                reason: by[eid].reason
            });
        });
        return out;
    };

    /** A line an office can read. */
    S.explain = function (change, fmt) {
        var f = typeof fmt === 'function' ? fmt : function (n) { return '$' + round2(n).toFixed(2); };
        if (!change) return '';
        if (change.direction === 'more_discount') {
            return change.camperName + ': sibling discount ' +
                   (change.was > 0 ? 'increased to ' : 'applied, ') + f(change.now) +
                   ' — they owe ' + f(Math.abs(change.delta)) + ' less';
        }
        return change.camperName + ': sibling discount ' +
               (change.now > 0 ? 'reduced to ' + f(change.now) : 'no longer applies') +
               ' — they owe ' + f(Math.abs(change.delta)) + ' more';
    };

    if (typeof root !== 'undefined' && root) root.CampistrySiblingDiscount = S;
    if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(typeof window !== 'undefined' ? window : null);
