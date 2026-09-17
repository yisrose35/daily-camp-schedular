// =============================================================================
// campistry_deposit_policy.js — the deposit a camp requires to register
//
// Camps hold a place with money. "A $250 deposit with the application,
// non-refundable, one per family" is a sentence every camp says differently:
// some charge a flat amount, some a percentage of tuition, some a figure that
// belongs to the session itself. Some will not look at an application until it
// is paid; others take it and expect the money inside two weeks.
//
// So this does not pick one. It holds the camp's answer and works out, for a
// given application, what is owed and whether it blocks submission. Every
// consumer — the public registration form, the office's Registration list,
// Billing — reads the same answer from here rather than each re-deriving it
// from the settings and quietly disagreeing about siblings.
//
// A deposit is a PAYMENT TOWARD TUITION, never an extra charge. Nothing here
// adds to what a family owes; it says how much of what they already owe has to
// arrive early. Getting that backwards would bill every camper twice.
// =============================================================================
(function () {
    'use strict';

    var P = {};

    P.DEFAULTS = {
        enabled:    false,
        // Where the number comes from.
        //   flat     — one amount, camp-wide
        //   percent  — a share of the session's tuition
        //   session  — whatever that session carries, which is the field the
        //              Sessions & Pricing screen already writes
        basis:      'flat',
        amount:     0,      // basis 'flat'
        percent:    25,     // basis 'percent', and the fallback for 'session'
        per:        'camper',   // or 'family' — one deposit however many siblings
        timing:     'now',      // or 'later'
        // Does the form REFUSE to submit until the deposit is actually paid?
        //
        // Separate from timing on purpose. timing 'now' means "due with the
        // application", which is a bookkeeping state -- the application goes
        // through and sits as awaiting deposit. mandatory means the place is
        // not even applied for until the money is in, which is a much stronger
        // thing and not what most camps want. Off by default, and only
        // meaningful with timing 'now'.
        mandatory:  false,
        dueDays:    14,         // timing 'later': days from applying
        refundable: false,
        // Most camps treat a deposit as the first slice of tuition. Some do
        // not -- a non-refundable holding fee, or an admin charge that sits on
        // top -- and telling a family it "counts toward tuition" when it does
        // not is a promise the camp then has to walk back.
        countsTowardTuition: true,
        label:      'Registration deposit',
        note:       ''          // the camp's own words, shown to parents
    };

    function num(v, fallback) {
        var n = Number(v);
        return isFinite(n) && n >= 0 ? n : fallback;
    }

    /** A stored policy with every field present and sane. */
    P.normalize = function (raw) {
        var r = (raw && typeof raw === 'object') ? raw : {};
        var out = {};
        Object.keys(P.DEFAULTS).forEach(function (k) { out[k] = P.DEFAULTS[k]; });

        out.enabled    = !!r.enabled;
        out.basis      = ['flat', 'percent', 'session'].indexOf(r.basis) >= 0 ? r.basis : 'flat';
        out.amount     = num(r.amount, 0);
        // A 0% or 100%+ deposit is a policy nobody means; clamp rather than
        // letting a typo bill a whole tuition up front.
        out.percent    = Math.min(100, num(r.percent, P.DEFAULTS.percent));
        out.per        = r.per === 'family' ? 'family' : 'camper';
        out.timing     = r.timing === 'later' ? 'later' : 'now';
        // A deposit that can be paid later cannot also be required up front,
        // so the two can never disagree.
        out.mandatory  = out.timing === 'now' && !!r.mandatory;
        out.dueDays    = Math.round(num(r.dueDays, P.DEFAULTS.dueDays));
        out.refundable = !!r.refundable;
        out.countsTowardTuition = r.countsTowardTuition !== false;
        out.label      = String(r.label || P.DEFAULTS.label).trim() || P.DEFAULTS.label;
        out.note       = String(r.note || '').trim();
        return out;
    };

    function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

    /**
     * What one camper's deposit comes to.
     *
     * Never more than the tuition itself: a percentage of a cheap session, or
     * a flat amount larger than a half-day week, would otherwise ask a family
     * for more than they owe in total and leave the camp holding a credit.
     */
    P.perCamperAmount = function (policy, session, tuition) {
        var pol = P.normalize(policy);
        if (!pol.enabled) return 0;
        var t = num(tuition, 0);
        var amt;
        if (pol.basis === 'flat') {
            amt = pol.amount;
        } else if (pol.basis === 'percent') {
            amt = t * pol.percent / 100;
        } else {
            // 'session' — the number on the session, which is what Sessions &
            // Pricing already stores. A session that never had one falls back
            // to the percentage rather than to nothing, so turning the policy
            // on does not silently ask for $0.
            var own = num((session || {}).depositAmount, 0);
            amt = own > 0 ? own : t * pol.percent / 100;
        }
        amt = round2(amt);
        if (t > 0 && amt > t) amt = t;
        return amt;
    };

    /**
     * What this application owes up front.
     *
     * campers: [{ session, tuition }] — one entry per camper on the form, so
     * siblings are counted where the camp counts them and not where it does
     * not. 'family' charges the LARGEST single camper's deposit rather than
     * the first: with a policy of "25% of tuition, one per family" a household
     * enrolling a full season and a taster week owes the season's deposit, and
     * form order is not a thing a parent should be able to change the price by.
     */
    P.amountFor = function (policy, campers) {
        var pol = P.normalize(policy);
        var list = Array.isArray(campers) ? campers : [];
        if (!pol.enabled || !list.length) {
            return { total: 0, per: pol.per, each: [], policy: pol };
        }
        var each = list.map(function (c) {
            return round2(P.perCamperAmount(pol, (c || {}).session, (c || {}).tuition));
        });
        var total = pol.per === 'family'
            ? each.reduce(function (a, b) { return Math.max(a, b); }, 0)
            : each.reduce(function (a, b) { return a + b; }, 0);
        return { total: round2(total), per: pol.per, each: each, policy: pol };
    };

    /** True when an application cannot be submitted until the deposit is paid. */
    P.blocksSubmission = function (policy, total) {
        var pol = P.normalize(policy);
        return !!(pol.enabled && pol.timing === 'now' && num(total, 0) > 0);
    };

    /** When a pay-later deposit is due, as YYYY-MM-DD. */
    P.dueDate = function (policy, fromISO) {
        var pol = P.normalize(policy);
        if (!pol.enabled || pol.timing !== 'later') return '';
        var base = fromISO ? new Date(fromISO) : new Date();
        if (isNaN(base.getTime())) base = new Date();
        base.setDate(base.getDate() + pol.dueDays);
        return base.toISOString().split('T')[0];
    };

    function money(n) {
        var v = Number(n) || 0;
        return '$' + (Math.round(v * 100) / 100).toLocaleString(undefined, {
            minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2
        });
    }
    P.money = money;

    /**
     * The policy in a sentence a parent reads, built from what they actually
     * owe rather than from the settings. "25% of tuition" is the camp's rule;
     * "$312.50 to hold your place, due today" is the parent's question.
     */
    P.describe = function (policy, result) {
        var pol = P.normalize(policy);
        if (!pol.enabled) return '';
        var total = (result && result.total) || 0;
        if (!total) return '';
        var s = money(total);
        var who = pol.per === 'family' && (result.each || []).length > 1
            ? ' for the family' : '';
        var when = pol.timing !== 'now'
            ? ' is due within ' + pol.dueDays + ' day' + (pol.dueDays === 1 ? '' : 's')
            : pol.mandatory
                ? ' must be paid to send this application'
                : ' is due now to complete this application';
        // Said in the order a parent cares about it: does it come off what I
        // owe, and do I get it back.
        var counts = pol.countsTowardTuition
            ? '. It counts toward tuition'
            : '. It is charged on top of tuition';
        return s + who + when + counts +
               (pol.refundable ? ' and is refundable' : ' and is not refundable') + '.';
    };

    /** Where the number came from, for the office rather than the parent. */
    P.explain = function (policy, result) {
        var pol = P.normalize(policy);
        if (!pol.enabled) return 'No deposit is required to register.';
        var basis = pol.basis === 'flat' ? money(pol.amount) + ' per camper'
                  : pol.basis === 'percent' ? pol.percent + '% of tuition'
                  : "the session's own deposit (" + pol.percent + '% where a session has none)';
        return basis + ', ' + (pol.per === 'family' ? 'once per family' : 'per camper') + ', ' +
               (pol.timing !== 'now' ? 'due ' + pol.dueDays + ' days after applying'
                : pol.mandatory ? 'required before an application can be submitted'
                // This was the wording for every timing-'now' policy, and it
                // was not true: the form went through and the application sat
                // as awaiting deposit. Only `mandatory` actually blocks.
                : 'due with the application, which is held as awaiting deposit until it arrives') + '.' +
               ((result && result.total) ? ' This application: ' + money(result.total) + '.' : '');
    };

    /**
     * The deposit fields to stamp on an application.
     *
     * Recorded as REQUIRED and PAID separately, never as a single "paid"
     * boolean: a camp that raises its deposit mid-season must not retroactively
     * make last month's applications look short, and one that turns the policy
     * off must not erase what an applicant already owed.
     */
    P.stampFor = function (policy, result, nowISO) {
        var pol = P.normalize(policy);
        var total = (result && result.total) || 0;
        if (!pol.enabled || !total) return { depositRequired: 0 };
        return {
            depositRequired:   total,
            depositPaid:       0,
            depositCountsTowardTuition: pol.countsTowardTuition,
            depositPer:        pol.per,
            depositTiming:     pol.timing,
            depositDue:        pol.timing === 'later' ? P.dueDate(pol, nowISO) : (nowISO || '').slice(0, 10),
            depositRefundable: pol.refundable,
            depositLabel:      pol.label
        };
    };

    /** Outstanding deposit on an application, or 0. */
    P.outstanding = function (enrollment) {
        var e = enrollment || {};
        var req = num(e.depositRequired, 0);
        if (!req) return 0;
        return round2(Math.max(0, req - num(e.depositPaid, 0)));
    };

    if (typeof globalThis !== 'undefined') globalThis.CampistryDepositPolicy = P;
    if (typeof window !== 'undefined') window.CampistryDepositPolicy = P;
    if (typeof module !== 'undefined' && module.exports) module.exports = P;
})();
