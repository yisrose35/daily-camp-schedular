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
// NOTHING IS WITHHELD BY DEFAULT. THE CAMP DECIDES.
//
// Every method in the catalogue is available out of the box, and a camp turns off
// what it does not take. That is the opposite of how this file started: debit was
// refused by default, reasoning that tuition on debit leaves the camp carrying
// chargeback and NSF exposure without the protections a credit card gives either
// side, and that debit rails do not carry installment plans.
//
// That reasoning is still true and still worth knowing — but it is a BUSINESS
// judgement, and not this software's to make. A camp that wanted debit had to ask a
// developer to change a default, which is the wrong shape for a decision belonging
// to whoever runs the camp.
//
// So the MECHANISM stays and the blocked LIST starts empty. `enabled` narrows the
// catalogue to what a camp accepts, and a refused method still renders struck
// through with its reason — because a method that is simply absent reads as an
// oversight somebody adds back in six months, while one shown as refused reads as a
// decision. The mechanism was always the useful part; the default was the
// presumptuous part.
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
        // An ordinary method like any other. The header says what a camp takes on by
        // accepting it for tuition — worth reading, not worth being decided for them.
        { id: 'debit',   label: 'Debit card',       contexts: ['tuition', 'canteen', 'shop', 'luggage'], default: true },
        { id: 'cash',    label: 'Cash',             contexts: ['tuition', 'canteen', 'shop', 'luggage'], default: true },
        { id: 'check',   label: 'Check',            contexts: ['tuition', 'canteen', 'shop', 'luggage'], default: true },
        { id: 'ach',     label: 'ACH / bank transfer', contexts: ['tuition', 'canteen', 'shop', 'luggage'], default: true },
        // default:true for tuition — the registration form's own payment
        // picker already offers Zelle as a first-class choice, so a parent
        // who picks it there must have a matching option when staff record
        // the payment in Billing's ledger.
        { id: 'zelle',   label: 'Zelle',            contexts: ['tuition', 'canteen', 'shop', 'luggage'], default: true },
        // default:false — a wire is rare enough that it doesn't belong in the
        // Record Payment picker unless a camp turns it on. It's in the
        // catalogue at all so label() resolves it: automatic deposit capture
        // classifies incoming wires as kind 'wire', and without an entry here
        // the family ledger renders the raw id ("wire") as the category.
        { id: 'wire',    label: 'Wire transfer',    contexts: ['tuition'],                                default: true },
        { id: 'paypal',  label: 'PayPal',           contexts: ['tuition'],                                default: true },
        { id: 'plan',    label: 'Payment plan',     contexts: ['tuition'],                                default: true },
        { id: 'canteen', label: 'Charge to canteen account', contexts: ['shop'],                          default: true },
        { id: 'bill',    label: 'Charge to camp bill',       contexts: ['shop', 'luggage'],               default: true },
        { id: 'other',   label: 'Other',            contexts: ['tuition'],                                default: true }
    ];

    /**
     * Methods a camp has refused, shown struck through with the reason.
     *
     * EMPTY BY DEFAULT — nothing is withheld unless a camp says so.
     */
    P.BLOCKED = [];

    var DEFAULT_POLICY = {
        // Kept so a stored policy that named it still means what it said. Debit is an
        // ordinary catalogue method now, so this matters only to a camp that
        // explicitly turned it off.
        allowDebit: true,
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
     *
     * Debit is no longer special-cased: it is a catalogue entry like the rest, so it
     * arrives through the same filter and cannot be listed twice. The one thing
     * still honoured separately is a stored `allowDebit: false` — a camp that said
     * no back when saying no was a setting.
     */
    P.forContext = function (context, policyRaw) {
        var pol = P.policy(policyRaw);
        return P.METHODS.filter(function (m) {
            if (m.contexts.indexOf(context) < 0) return false;
            if (m.id === 'debit' && pol.allowDebit === false) return false;
            if (Array.isArray(pol.enabled)) return pol.enabled.indexOf(m.id) >= 0;
            return m.default;
        });
    };

    /** Methods this camp has refused, so the gap reads as a choice and not a bug. */
    P.blockedFor = function (context, policyRaw) {
        var pol = P.policy(policyRaw);
        var out = P.BLOCKED.filter(function (b) {
            return !b.contexts || b.contexts.indexOf(context) >= 0;
        });
        if (pol.allowDebit === false && !out.some(function (b) { return b.id === 'debit'; })) {
            out.push({ id: 'debit', label: 'Debit card', reason: 'Not accepted here',
                       detail: 'This camp has turned debit off.' });
        }
        return out;
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
