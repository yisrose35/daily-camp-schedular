/* =============================================================================
 * campistry_acceptance_letter.js — the one email a family gets when they are
 * accepted.
 *
 * It used to be two thin ones: a portal invite carrying an access code and
 * nothing else, and (if the camp turned it on) a post-acceptance form link.
 * Neither told a parent the two numbers they need all summer -- their child's
 * camper ID and the camp number -- so the first time either mattered was when
 * a payment arrived with no reference and nobody could tell whose it was.
 *
 * PURE ON PURPOSE. No DOM, no network, no globals: it takes facts and returns
 * a subject and a body. That is what makes the wording testable, which matters
 * more here than anywhere else in the app, because this email goes to every
 * family exactly once and a mistake in it cannot be taken back.
 *
 * Every part is OPTIONAL and disappears cleanly when the camp does not have
 * it. A camp with no camp number set, or a camper with no ID, gets a letter
 * that reads as though that section was never meant to be there -- rather than
 * "Camper ID: undefined", which is how this normally goes wrong.
 * ========================================================================== */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.CampistryAcceptanceLetter = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    var A = {};

    function str(v) { return String(v == null ? '' : v).trim(); }

    /** First name, for a greeting. "Yitz Rosenfeld" -> "Yitz". */
    function first(name) {
        var s = str(name);
        if (!s) return '';
        return s.split(/\s+/)[0];
    }

    /**
     * The payment reference: campNumber-camperId.
     *
     * Deliberately rebuilt here rather than imported from
     * campistry_deposit_match.js -- this file has to work in a plain Node test
     * and inside the browser, and the rule is four characters of logic. It is
     * the SAME rule, and there is a test that holds the two together.
     */
    A.reference = function (campNumber, camperId) {
        var camp = str(campNumber).replace(/\D/g, '');
        var kid = str(camperId).replace(/\D/g, '');
        if (!camp || !kid) return '';
        return camp + '-' + kid;
    };

    /**
     * facts: {
     *   camperName, camperId, parentName, campName, session,
     *   accessCode, portalUrl, camperIdLabel?,
     *   campNumber, postAcceptUrl, officeEmail, officePhone
     * }
     */
    A.build = function (facts) {
        var f = facts || {};
        var camper = str(f.camperName) || 'your camper';
        var camperFirst = first(camper) || 'your camper';
        var camp = str(f.campName) || 'Camp';
        var parentFirst = first(f.parentName);
        var lines = [];

        lines.push(parentFirst ? 'Dear ' + parentFirst + ',' : 'Hello,');
        lines.push('');
        lines.push(str(f.session)
            ? camperFirst + ' has been accepted to ' + camp + ' for ' + str(f.session) + '.'
            : camperFirst + ' has been accepted to ' + camp + '.');
        lines.push('');

        // ── getting in ───────────────────────────────────────────────────────
        // Numbered, because "create an account and enter your code" is two
        // steps a parent does on a phone, in a queue, once.
        var portal = str(f.portalUrl);
        var code = str(f.accessCode);
        if (code || portal) {
            lines.push('GETTING INTO CAMPISTRY LINK');
            lines.push('Campistry Link is where you will see ' + camperFirst +
                       "'s schedule, photos, messages from us, and your balance.");
            if (code) {
                // With a code, the parent makes their OWN account -- the link
                // is just where to go, so it is step one, not the whole thing.
                if (portal) lines.push('  1. Go to ' + portal);
                lines.push('  ' + (portal ? '2' : '1') + '. Create your account using this email address');
                lines.push('  ' + (portal ? '3' : '2') + '. Enter your access code: ' + code);
            } else {
                lines.push('  Open this link to get started: ' + portal);
            }
            lines.push('');
        }

        // ── the numbers ──────────────────────────────────────────────────────
        var camperId = str(f.camperId);
        var campNo = str(f.campNumber);
        var ref = A.reference(campNo, camperId);
        if (camperId || campNo) {
            lines.push('YOUR NUMBERS');
            if (camperId) lines.push('  ' + camperFirst + "'s camper ID: " + camperId);
            if (campNo) lines.push('  Camp number: ' + campNo);
            if (ref) {
                lines.push('  Payment reference: ' + ref);
                lines.push('    Put ' + ref + ' in the memo of any Zelle or bank transfer and');
                lines.push('    it is credited to ' + camperFirst + "'s account automatically.");
            }
            lines.push('');
        }

        // ── what to do next ──────────────────────────────────────────────────
        var paf = str(f.postAcceptUrl);
        if (paf) {
            lines.push('A FEW MORE CHOICES');
            lines.push('Please fill this in when you have a moment: ' + paf);
            lines.push('');
        }

        // ── how to reach a person ────────────────────────────────────────────
        var contact = [];
        if (str(f.officeEmail)) contact.push(str(f.officeEmail));
        if (str(f.officePhone)) contact.push(str(f.officePhone));
        if (contact.length) {
            lines.push('Any questions, just reply to this email or reach us at ' +
                       contact.join(' or ') + '.');
            lines.push('');
        }

        lines.push('We are looking forward to a wonderful summer.');
        lines.push('');
        lines.push(camp + ' Office');

        return {
            subject: camperFirst + ' is accepted — welcome to ' + camp,
            body: lines.join('\n'),
            // What the letter could NOT say, so a caller can warn the office
            // rather than a parent finding out there was nothing to act on.
            missing: [
                code || portal ? null : 'portal access',
                camperId ? null : 'camper ID',
                campNo ? null : 'camp number'
            ].filter(Boolean)
        };
    };

    return A;
});
