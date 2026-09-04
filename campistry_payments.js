// =============================================================================
// campistry_payments.js — one payment-method policy for the whole camp
//
// Every place that takes money used to keep its own hard-coded <option> list:
// registration, Billing's Record Payment, the canteen, the shop. They drifted
// (registration offered "Credit / Debit Card" while nothing else mentioned
// debit at all), and a camp changing its policy had to be chased through four
// files. This module is the single catalogue.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY DEBIT IS BLOCKED
//
// This is a TUITION policy first. Camps that take tuition on debit eat the
// chargeback and NSF exposure without the protections a credit card gives
// either side, and debit rails don't support the installment plans tuition is
// usually paid on. So the camp accepts credit cards and refuses debit.
//
// It's listed as an explicit BLOCKED entry rather than simply left out of the
// catalogue, because a missing option reads as an oversight — someone adds it
// back six months later. A struck-through row with the reason attached reads
// as a decision.
//
// Camps that disagree can turn it back on: setPolicy({ allowDebit: true }).
// The block is a default, not a law.
//
// The canteen and the shop inherit the same stance, and for the canteen there
// is a second reason on top: a canteen balance is prepaid money a camper can
// draw back out as cash, which makes funding it from debit a cash-equivalent
// transaction.
// ─────────────────────────────────────────────────────────────────────────────
//
// CONTEXTS. A method can be valid in one place and meaningless in another —
// "charge to camp bill" makes sense in the shop and not for tuition itself.
// Each method declares the contexts it belongs to.
//
// Exposed as window.CampistryPayments (browser) and module.exports (tests).
// =============================================================================
(function () {
    'use strict';

    var P = {};

    P.CONTEXTS = ['tuition', 'canteen', 'shop', 'luggage'];

    P.METHODS = [
        { id: 'credit',  label: 'Credit card',      contexts: ['tuition', 'canteen', 'shop', 'luggage'], default: true },
        { id: 'cash',    label: 'Cash',             contexts: ['tuition', 'canteen', 'shop', 'luggage'], default: true },
        { id: 'check',   label: 'Check',            contexts: ['tuition', 'canteen', 'shop', 'luggage'], default: true },
        { id: 'ach',     label: 'ACH / bank transfer', contexts: ['tuition', 'canteen', 'shop', 'luggage'], default: true },
        // default:true for tuition — the registration form's own payment
        // picker already offers Zelle as a first-class choice, so a parent
        // who picks it there must have a matching option when staff record
        // the payment in Billing's ledger.
        { id: 'zelle',   label: 'Zelle',            contexts: ['tuition', 'canteen', 'shop', 'luggage'], default: true },
        { id: 'paypal',  label: 'PayPal',           contexts: ['tuition'],                                default: false },
        { id: 'plan',    label: 'Payment plan',     contexts: ['tuition'],                                default: true },
        { id: 'canteen', label: 'Charge to canteen account', contexts: ['shop'],                          default: false },
        { id: 'bill',    label: 'Charge to camp bill',       contexts: ['shop', 'luggage'],               default: true },
        { id: 'other',   label: 'Other',            contexts: ['tuition'],                                default: false }
    ];

    // Refused by default, with the reason surfaced wherever methods are listed.
    P.BLOCKED = [
        {
            id: 'debit',
            label: 'Debit card',
            reason: 'Not accepted for tuition',
            detail: 'Debit leaves the camp carrying the chargeback and NSF exposure ' +
                    'without the protections a credit card gives either side, and it ' +
                    'can\'t carry an installment plan. Credit cards are accepted.'
        }
    ];

    var DEFAULT_POLICY = {
        allowDebit: false,
        // null means "use each method's own default"; a camp that edits the
        // list gets an explicit array stored instead.
        enabled: null
    };

    function readSettings() {
        try {
            var raw = localStorage.getItem('campGlobalSettings_v1');
            var g = raw ? JSON.parse(raw) : {};
            return (g.campistryMe && g.campistryMe.paymentPolicy) || null;
        } catch (e) { return null; }
    }

    P.policy = function (raw) {
        var p = (raw && typeof raw === 'object') ? raw
              : (typeof localStorage !== 'undefined' ? readSettings() : null);
        return Object.assign({}, DEFAULT_POLICY, p || {});
    };

    P.method = function (id) {
        return P.METHODS.filter(function (m) { return m.id === id; })[0] || null;
    };

    P.label = function (id) {
        var m = P.method(id);
        if (m) return m.label;
        var b = P.BLOCKED.filter(function (x) { return x.id === id; })[0];
        return b ? b.label : (id || '—');
    };

    /**
     * The methods offered in a context, honouring the camp's policy.
     * Debit only appears if the camp explicitly re-enabled it.
     */
    P.forContext = function (context, policyRaw) {
        var pol = P.policy(policyRaw);
        var out = P.METHODS.filter(function (m) {
            if (m.contexts.indexOf(context) < 0) return false;
            if (Array.isArray(pol.enabled)) return pol.enabled.indexOf(m.id) >= 0;
            return m.default;
        });
        if (pol.allowDebit) {
            out.push({ id: 'debit', label: 'Debit card', contexts: P.CONTEXTS, default: false });
        }
        return out;
    };

    /** Blocked methods worth SHOWING in this context, so the gap reads as a choice. */
    P.blockedFor = function (context, policyRaw) {
        var pol = P.policy(policyRaw);
        if (pol.allowDebit) return [];
        return P.BLOCKED.slice();
    };

    /**
     * Guard for the save path. A tampered DOM, a stale tab or an old stored
     * value must not slip a refused method through.
     */
    P.isAllowed = function (id, context, policyRaw) {
        return P.forContext(context, policyRaw).some(function (m) { return m.id === id; });
    };

    /** <option> markup for a <select>. */
    P.optionsHtml = function (context, selected, policyRaw) {
        return P.forContext(context, policyRaw).map(function (m) {
            return '<option value="' + m.id + '"' + (selected === m.id ? ' selected' : '') + '>' + m.label + '</option>';
        }).join('');
    };

    /**
     * Legacy free-text methods ("Credit Card", "ACH / Bank Transfer") were
     * stored as display strings, not ids. Map them so old records keep
     * rendering — and so a stored "Credit / Debit Card" resolves to credit
     * rather than reviving debit.
     */
    P.normalizeLegacy = function (value) {
        var s = String(value || '').toLowerCase().trim();
        if (!s) return '';
        if (P.method(s)) return s;
        if (/credit/.test(s)) return 'credit';        // covers "Credit / Debit Card"
        if (/^debit/.test(s)) return 'debit';
        if (/check|cheque/.test(s)) return 'check';
        if (/cash/.test(s)) return 'cash';
        if (/ach|bank|wire|transfer/.test(s)) return 'ach';
        if (/zelle/.test(s)) return 'zelle';
        if (/paypal/.test(s)) return 'paypal';
        if (/plan|installment/.test(s)) return 'plan';
        if (/canteen/.test(s)) return 'canteen';
        if (/bill|account/.test(s)) return 'bill';
        return 'other';
    };

    if (typeof window !== 'undefined') window.CampistryPayments = P;
    if (typeof module !== 'undefined' && module.exports) module.exports = P;
})();
