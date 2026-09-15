// =============================================================================
// campistry_finance_merge.js — keep server-written money out of the clobber
//
// THE PROBLEM
//
// `campistryMe` is one camp_state_kv row that the browser rewrites WHOLE on
// every save, from state it read when the page loaded. That is fine while the
// browser is the only writer. It is not the only writer:
//
//   charge-due-installments  appends finance.payments, marks an installment paid
//   stripe-webhook           sets stripeCustomerId / cardOnFile / savedPaymentMethods
//   cardknox-webhook         same, for card-on-file via Cardknox
//   payments-save-method     same, for BYOP processors
//   payments-hosted-complete appends finance.payments after a hosted checkout
//
// So: autopay charges a card at 02:00 and appends the payment. The office has
// had Me open since the night before. At 09:00 they rename a bunk, save() runs,
// and the whole blob goes up from memory that predates the charge. The payment
// is gone, the family owes it again -- and the installment is back to 'pending',
// so the next night the cron charges the same card a second time.
//
// The vanishing balance is the visible half. The double charge is the expensive
// half, and the two have the same cause.
//
// WHY MERGE RATHER THAN MOVE
//
// Bank deposits solved this by living in their own table and joining the ledger
// at read time (migration 145). That is the better shape and these payments
// should get there too. Until they do, a merge at write time closes the hole,
// and it can be exact rather than approximate because both quantities are
// append-or-advance only:
//
//   * a payment is identified by its id and is never un-made -- a refund is a
//     new negative row, not an edit
//   * an installment goes pending -> paid and never back
//
// So "keep anything the cloud has that we do not" is not a heuristic here, it
// is the correct rule. Local still wins on ids it also has: the office
// legitimately edits and refunds payments it can see.
//
// DELIBERATELY NARROW
//
// Only payments, installment status, and the card-on-file fields autopay needs
// to run at all. A deleted family, a renamed household, a corrected enrollment
// are all real local edits that must not be resurrected by a merge.
// =============================================================================
(function () {
    'use strict';

    var M = {};

    function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
    function list(v) { return Array.isArray(v) ? v : []; }

    /** A payment's identity. Falls back to its shape when an id is missing. */
    M.paymentKey = function (p) {
        if (!isObj(p)) return '';
        if (p.id) return 'id:' + String(p.id);
        // Legacy and hand-recorded rows predate ids. Reference first (a
        // processor transaction id is unique), then the tuple that makes two
        // rows genuinely the same payment.
        if (p.reference) return 'ref:' + String(p.reference);
        return 'shape:' + [p.familyKey || p.family || '', p.date || '', p.amount, p.method || ''].join('|');
    };

    /**
     * Payments the cloud has and we do not, appended in cloud order.
     *
     * Local order and local content both win for anything we already know
     * about -- this only puts back what a server wrote while we were not
     * looking.
     */
    M.mergePayments = function (localPayments, cloudPayments) {
        var out = list(localPayments).slice();
        var have = {};
        out.forEach(function (p) { var k = M.paymentKey(p); if (k) have[k] = true; });
        list(cloudPayments).forEach(function (p) {
            var k = M.paymentKey(p);
            if (!k || have[k]) return;
            have[k] = true;
            out.push(p);
        });
        return out;
    };

    /** Every plan on a family, old singular `plan` and new `plans[]` alike. */
    function plansOf(f) {
        if (!isObj(f)) return [];
        if (Array.isArray(f.plans)) return f.plans.filter(isObj);
        if (isObj(f.plan) && Array.isArray(f.plan.installments)) return [f.plan];
        return [];
    }

    function planId(p, i) { return String((isObj(p) && p.id) || ('#' + i)); }
    function instId(inst, i) {
        return String((isObj(inst) && (inst.id || inst.label + '|' + inst.dueDate)) || ('#' + i));
    }

    /**
     * Carry a cloud installment's PAID state onto the local copy.
     *
     * Only pending -> paid, never the reverse: a local copy that already says
     * paid knows something the cloud does not (the office just marked it), and
     * un-paying an installment is what makes the cron charge the card again.
     */
    M.mergeInstallments = function (localFamilies, cloudFamilies) {
        var out = isObj(localFamilies) ? localFamilies : {};
        var cloud = isObj(cloudFamilies) ? cloudFamilies : {};
        var restored = 0;

        Object.keys(out).forEach(function (fk) {
            var lf = out[fk], cf = cloud[fk];
            if (!isObj(lf) || !isObj(cf)) return;

            var cPlans = {};
            plansOf(cf).forEach(function (p, i) {
                var byInst = {};
                list(p.installments).forEach(function (inst, j) { byInst[instId(inst, j)] = inst; });
                cPlans[planId(p, i)] = byInst;
            });

            plansOf(lf).forEach(function (p, i) {
                var cInsts = cPlans[planId(p, i)];
                if (!cInsts) return;
                list(p.installments).forEach(function (inst, j) {
                    if (!isObj(inst) || inst.status === 'paid') return;
                    var c = cInsts[instId(inst, j)];
                    if (!isObj(c) || c.status !== 'paid') return;
                    inst.status = 'paid';
                    if (c.paidDate) inst.paidDate = c.paidDate;
                    if (c.note) inst.note = c.note;
                    if (c.stripePaymentIntentId) inst.stripePaymentIntentId = c.stripePaymentIntentId;
                    if (c.byopTransactionId) inst.byopTransactionId = c.byopTransactionId;
                    // The cron rewrites amount when it charged less than was
                    // scheduled; keeping the schedule's number would overstate
                    // what is still owed.
                    if (typeof c.amount === 'number') inst.amount = c.amount;
                    restored++;
                });
            });
        });
        return restored;
    };

    // Written only by the processor webhooks. A browser never sets them, so a
    // local blank is always staleness rather than an edit -- and a blank one is
    // why autopay logs "autopay is on but no card on file" and stops charging.
    var CARD_FIELDS = ['cardOnFile', 'stripeCustomerId', 'stripePaymentMethodId',
                       'byopCustomerRef', 'byopProcessor'];

    M.mergeCardFields = function (localFamilies, cloudFamilies) {
        var out = isObj(localFamilies) ? localFamilies : {};
        var cloud = isObj(cloudFamilies) ? cloudFamilies : {};
        var restored = 0;

        Object.keys(out).forEach(function (fk) {
            var lf = out[fk], cf = cloud[fk];
            if (!isObj(lf) || !isObj(cf)) return;

            CARD_FIELDS.forEach(function (k) {
                var blank = lf[k] === undefined || lf[k] === null || lf[k] === '' || lf[k] === false;
                var has = cf[k] !== undefined && cf[k] !== null && cf[k] !== '' && cf[k] !== false;
                if (blank && has) { lf[k] = cf[k]; restored++; }
            });

            // savedPaymentMethods is a list the webhooks append to, keyed by
            // the processor's own token.
            var lm = list(lf.savedPaymentMethods), cm = list(cf.savedPaymentMethods);
            if (cm.length) {
                var seen = {};
                lm.forEach(function (m) {
                    var k = String((isObj(m) && (m.id || m.token || m.customerRef || m.last4)) || '');
                    if (k) seen[k] = true;
                });
                var added = cm.filter(function (m) {
                    var k = String((isObj(m) && (m.id || m.token || m.customerRef || m.last4)) || '');
                    return k && !seen[k];
                });
                if (added.length) { lf.savedPaymentMethods = lm.concat(added); restored += added.length; }
            }
        });
        return restored;
    };

    /**
     * The whole job: what this browser is about to write, with everything a
     * server wrote in the meantime put back. Mutates and returns `local`.
     */
    M.mergeCampistryMe = function (local, cloud) {
        if (!isObj(local) || !isObj(cloud)) return local;
        var report = { payments: 0, installments: 0, cards: 0 };

        var lFin = isObj(local.finance) ? local.finance : null;
        var cFin = isObj(cloud.finance) ? cloud.finance : null;
        if (lFin && cFin) {
            var before = list(lFin.payments).length;
            lFin.payments = M.mergePayments(lFin.payments, cFin.payments);
            report.payments = lFin.payments.length - before;
        } else if (!lFin && cFin) {
            // Section access scrubs finance for a user without Billing. They
            // must not write the scrub back as truth.
            local.finance = cFin;
            report.payments = list(cFin.payments).length;
        }

        report.installments = M.mergeInstallments(local.families, cloud.families);
        report.cards = M.mergeCardFields(local.families, cloud.families);

        local._financeMergeReport = report;
        return local;
    };

    if (typeof globalThis !== 'undefined') globalThis.CampistryFinanceMerge = M;
    if (typeof window !== 'undefined') window.CampistryFinanceMerge = M;
    if (typeof module !== 'undefined' && module.exports) module.exports = M;
})();
