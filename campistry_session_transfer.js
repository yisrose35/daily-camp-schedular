/* =============================================================================
 * campistry_session_transfer.js — moving a camper from one session to another,
 * with the money following.
 *
 * THE PROBLEM. A camper is enrolled in 1st Half and the family asks to switch to
 * 2nd Half, or to extend to both. Today there is no operation for that. An office
 * issues a credit against one charge, adds another by hand, and the ledger ends up
 * holding two unrelated-looking entries that happen to cancel out. Nobody reading
 * it in February can tell it was a transfer, and if the two halves are priced
 * differently the difference is somebody's arithmetic rather than the system's.
 *
 * ── WHY THIS IS A CREDIT AND A NEW ENROLLMENT, NOT AN EDIT ──────────────────
 *
 * Two constraints in this codebase decide the shape, and both are load-bearing:
 *
 *   1. THE POSTED LEDGER IS IMMUTABLE. Corrections are new entries. Editing the
 *      tuition charge would rewrite history a parent may already have seen on a
 *      statement, and it is the one thing the ledger design refuses.
 *
 *   2. postTuition IS KEYED ON THE ENROLLMENT ID and refuses a second post for
 *      the same one — which is what stops a camper being double-billed on every
 *      render. Changing an enrollment's session in place would therefore leave the
 *      OLD session's charge standing, with nothing able to post the new one.
 *
 * So a transfer is: credit what is still standing against the old enrollment,
 * retire it, and create a NEW enrollment for the target session whose tuition posts
 * normally. Both ends carry `transferredTo` / `transferredFrom`, so the pair reads
 * as one event instead of two coincidences.
 *
 * The price difference needs no special handling and gets none: crediting the old
 * gross and charging the new gross leaves exactly the difference owing, whichever
 * direction it runs.
 *
 * ── WHAT THIS FILE DOES AND DOES NOT DO ────────────────────────────────────
 *
 * It PLANS. It takes the enrollment, the sessions and the ledger, and returns the
 * steps to take plus anything the office should be told first. It writes nothing.
 * That split is deliberate: the arithmetic is the part worth testing exhaustively,
 * and it can be, because it is a pure function of its inputs.
 * ========================================================================== */
(function (root) {
    'use strict';
    var T = {};

    function money(n) {
        var v = Math.round((Number(n) || 0) * 100) / 100;
        return Number.isFinite(v) ? v : 0;
    }
    function str(s) { return String(s == null ? '' : s).trim(); }

    /** Statuses a transfer may act on. A withdrawn enrollment is history. */
    T.TRANSFERABLE = { enrolled: 1, accepted: 1 };

    /**
     * What is still owed against one enrollment: its charges less its credits.
     *
     * Read from the POSTED entries rather than from the session's price, because
     * they can differ — a discount, a scholarship, a partial credit already issued.
     * Crediting the list price when a scholarship already covered half would hand
     * the family the difference as a windfall.
     */
    T.standingFor = function (entries, enrollmentId) {
        var eid = str(enrollmentId), total = 0;
        (Array.isArray(entries) ? entries : []).forEach(function (e) {
            if (!e || !e.source || str(e.source.enrollmentId) !== eid) return;
            if (e.kind === 'charge' || e.type === 'charge') total += money(e.amount);
            else if (e.kind === 'credit' || e.type === 'credit') total -= money(e.amount);
        });
        return money(total);
    };

    /**
     * Plan a transfer. Returns { ok, reason, message, steps, warnings, net }.
     *
     * `steps` is an ordered list of what to do, each one { do, ... }:
     *   { do:'credit',   amount, note, enrollmentId }   reverse the old charge
     *   { do:'retire',   enrollmentId, status, to }      mark the old one transferred
     *   { do:'enroll',   session, tuition, discount, from }  the new enrollment
     *
     * Never throws, and never returns steps when !ok — a caller that ignores `ok`
     * must not be able to half-transfer somebody.
     */
    T.plan = function (o) {
        o = o || {};
        var enr = o.enrollment || null;
        var eid = str(o.enrollmentId || (enr && enr.id));
        var to = str(o.toSession);
        var sessions = Array.isArray(o.sessions) ? o.sessions : [];
        var entries = Array.isArray(o.entries) ? o.entries : [];

        function no(reason, message) {
            return { ok: false, reason: reason, message: message,
                     steps: [], warnings: [], net: 0 };
        }

        if (!enr || !eid) return no('no_enrollment', 'That enrollment could not be found.');
        if (!to) return no('no_target', 'Choose the session to move them to.');

        var from = str(enr.session);
        if (from && from === to) {
            return no('same_session', enr.camperName
                ? (enr.camperName + ' is already on ' + to + '.')
                : 'They are already on that session.');
        }
        if (!T.TRANSFERABLE[str(enr.status)]) {
            return no('not_transferable',
                'Only an enrolled or accepted camper can be moved between sessions. '
                + 'This one is ' + (str(enr.status) || 'in no state to move') + '.');
        }

        var target = sessions.filter(function (s) { return s && str(s.name) === to; })[0];
        if (!target) return no('no_such_session', 'There is no session called "' + to + '".');

        var newGross = money(target.tuition);
        if (!(newGross > 0)) {
            return no('target_unpriced',
                '"' + to + '" has no tuition set, so moving them there would bill '
                + 'nothing. Set its price first.');
        }

        // The discount travels with the camper: a scholarship or sibling discount is
        // a fact about the family, not about which half they happen to be in. A
        // PERCENTAGE re-applies against the new price; a fixed amount is carried as
        // it stands, because that is what was agreed.
        var disc = 0;
        if (enr.discount) {
            disc = money((Number(enr.discount.amt) || 0)
                       + (newGross * (Number(enr.discount.pct) || 0) / 100));
            if (disc > newGross) disc = newGross;     // never discount past free
        }

        var standing = T.standingFor(entries, eid);
        var steps = [], warnings = [];

        // Credit only what is actually standing. Zero or less means the old charge
        // was never posted, or has already been fully credited — either way there is
        // nothing to reverse, and crediting anyway would invent money.
        if (standing > 0) {
            steps.push({ do: 'credit', enrollmentId: eid, amount: standing,
                         note: 'Transferred out of ' + (from || 'their session')
                             + ' — moved to ' + to });
        } else if (standing < 0) {
            warnings.push('This enrollment is already carrying a '
                + Math.abs(standing).toFixed(2) + ' credit. Nothing is being reversed, '
                + 'and the new session’s tuition is being added on top.');
        }

        steps.push({ do: 'retire', enrollmentId: eid, status: 'transferred', to: to });
        steps.push({ do: 'enroll', session: to, tuition: newGross, discount: disc,
                     from: from, fromEnrollmentId: eid,
                     camperName: str(enr.camperName) });

        // What the family will owe as a result, which is the only number the office
        // actually wants to hear before confirming.
        var net = money((newGross - disc) - standing);
        if (net < 0) {
            warnings.push(to + ' costs ' + Math.abs(net).toFixed(2)
                + ' less, so the family will be left with a credit of that much. '
                + 'It is not refunded automatically.');
        }

        return { ok: true, reason: 'ok', message: '', steps: steps, warnings: warnings,
                 net: net, standing: standing, newGross: newGross, discount: disc,
                 from: from, to: to };
    };

    /** A sentence for the confirmation dialog. Empty when there is nothing to say. */
    T.describe = function (p) {
        if (!p || !p.ok) return '';
        var bits = [];
        if (p.standing > 0) bits.push('credits ' + p.standing.toFixed(2)
            + ' back against ' + (p.from || 'their old session'));
        bits.push('charges ' + (p.newGross - p.discount).toFixed(2) + ' for ' + p.to);
        var s = 'This ' + bits.join(' and ') + '.';
        if (p.net > 0) s += ' The family will owe ' + p.net.toFixed(2) + ' more.';
        else if (p.net < 0) s += ' The family will be ' + Math.abs(p.net).toFixed(2)
                              + ' in credit.';
        else s += ' The balance does not change.';
        return s;
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = T;
    if (root) root.CampistrySessionTransfer = T;
})(typeof window !== 'undefined' ? window : null);
