/* =============================================================================
 * campistry_bulk.js — doing one thing to many accounts, and saying exactly what
 * will happen before any of it happens.
 *
 * THE PROBLEM THIS EXISTS FOR. Everything an office does in August it does to
 * dozens of families at once: run the second installment, put the sibling discount
 * on everyone who qualifies, apply the late fees for the month, spend down the
 * credits sitting on accounts that are about to be invoiced again. Campistry could
 * do each of those one family at a time, which for a 120-camper camp is not a
 * feature, it is a morning.
 *
 * And a bulk action is the one place where "it mostly worked" is unacceptable,
 * because nobody re-reads 120 rows to find the four that did not. So every function
 * here PLANS: it returns what will be done, what will be SKIPPED and why, and the
 * total, so an office sees the whole thing before it agrees to any of it. Nothing
 * here writes.
 *
 * ── THE FOUR THINGS ────────────────────────────────────────────────────────
 *
 * 1. AN INSTALLMENT RUN. campistry_installments.js made invoicing the event that
 *    advances a family's plan — but nothing ever ran it, so every schedule in the
 *    app sat `pending` forever and the aging report had nothing to age. This is the
 *    missing half: pick the families, invoice each one's next installment, and be
 *    told plainly about the ones that have nothing left to invoice rather than
 *    inventing an extra installment for them.
 *
 * 2. A BULK CREDIT OR CHARGE. Either the same amount to each account, or ONE total
 *    split across them. The split is in cents and the remainder rides on the first
 *    account, for the same reason the installment split does: a penny left over at
 *    the end of the summer is a balance somebody has to chase.
 *
 * 3. CREDITS COVERING WHAT IS OWED. A family with money on account being asked to
 *    pay a deposit is the app failing at arithmetic in public. Deposits and
 *    registration fees come first — they are the ones that BLOCK something (a place,
 *    a form, a bus seat) — then the oldest obligation.
 *
 * 4. LATE FEES, ACTUALLY APPLIED. campistry_ar.js proposes them and stamps each
 *    proposal with a key carrying the invoice and the period number. That key is
 *    only worth anything if somebody checks it, so this is the checker: run the
 *    month twice and the second run applies nothing.
 *
 * 5. TELLING THE FAMILY. An invoice nobody is told about is not an invoice. A run
 *    that marks installments invoiced and silently reaches nobody is worse than one
 *    that refuses, because the office then believes it has asked.
 *
 * Pure. It plans and reads; it writes nothing.
 * ========================================================================== */
(function (root) {
    'use strict';
    var B = {};

    function money(n) {
        var v = Math.round((Number(n) || 0) * 100) / 100;
        return Number.isFinite(v) ? v : 0;
    }
    function cents(n) { return Math.round((Number(n) || 0) * 100); }
    function str(s) { return String(s == null ? '' : s).trim(); }

    /**
     * The installments rule. Injectable for the same reason the payment catalogue
     * is: this file is a global in the browser and a require() in tests, and
     * without the second path an installment run could never be tested at all.
     */
    var _inst = null;
    B.useInstallments = function (I) { _inst = I || null; return B; };
    function installments(given) {
        if (given && typeof given.invoiceNext === 'function') return given;
        if (_inst && typeof _inst.invoiceNext === 'function') return _inst;
        try {
            var I = (typeof root !== 'undefined' && root && root.CampistryInstallments) || null;
            if (I && typeof I.invoiceNext === 'function') return I;
        } catch (e) {}
        return null;
    }

    // ── 1. an installment run ─────────────────────────────────────────────

    /** Why a family was left out of a run, in words an office can act on. */
    B.SKIP_REASONS = {
        no_schedule:   'Not on a payment plan',
        all_invoiced:  'Every installment already invoiced',
        no_rule:       'The payment-plan rule did not load',
        nothing_owed:  'Nothing left to invoice'
    };

    /**
     * Plan an installment run.
     *
     * o = {
     *   families: [{ key, name, schedule }],
     *   on:        the date the invoicing happens (today if omitted)
     *   dueDate:   what the office is asking for, recorded BESIDE the schedule's
     *              own date rather than over it — overwriting it would erase the
     *              fact that the camp billed late
     *   installments: the rule, if not a global
     * }
     *
     * Returns { ok, run: [...], skipped: [...], total, count }. Each `run` entry
     * carries the NEW schedule, so the caller stores it and never has to re-derive
     * which installment advanced.
     */
    B.planInvoiceRun = function (o) {
        o = o || {};
        var I = installments(o.installments);
        var fams = Array.isArray(o.families) ? o.families : [];
        var out = { ok: true, run: [], skipped: [], total: 0, count: 0 };

        if (!I) {
            fams.forEach(function (f) {
                if (!f) return;
                out.skipped.push({ key: str(f.key), name: str(f.name), reason: 'no_rule',
                                   message: B.SKIP_REASONS.no_rule });
            });
            out.ok = false;
            return out;
        }

        fams.forEach(function (f) {
            if (!f) return;
            var res = I.invoiceNext(f.schedule, { on: o.on, dueDate: o.dueDate });
            if (!res.ok) {
                out.skipped.push({ key: str(f.key), name: str(f.name), reason: res.reason,
                                   message: B.SKIP_REASONS[res.reason] || res.message || '' });
                return;
            }
            var amt = money(res.installment && res.installment.amount);
            if (!(amt > 0)) {
                // A zero installment would send a family an invoice asking for
                // nothing, which is worse than skipping them: they have to work out
                // whether it was a mistake.
                out.skipped.push({ key: str(f.key), name: str(f.name), reason: 'nothing_owed',
                                   message: B.SKIP_REASONS.nothing_owed });
                return;
            }
            out.run.push({
                key: str(f.key), name: str(f.name), amount: amt,
                index: res.index, installment: res.installment, schedule: res.schedule,
                label: str(res.installment.label) || ('Payment ' + (res.index + 1))
            });
            out.total = money(out.total + amt);
        });
        out.count = out.run.length;
        return out;
    };

    /** "42 families · 18,400.00 · 3 skipped". Empty when there is nothing to run. */
    B.describeRun = function (p) {
        if (!p || !p.count) return '';
        var bits = [p.count + ' famil' + (p.count === 1 ? 'y' : 'ies'),
                    money(p.total).toFixed(2)];
        if (p.skipped && p.skipped.length) bits.push(p.skipped.length + ' skipped');
        return bits.join(' · ');
    };

    // ── 2. a bulk credit or charge ────────────────────────────────────────

    B.MODES = [
        { id: 'each',  label: 'This amount to each account' },
        { id: 'split', label: 'Split this total between them' }
    ];

    /**
     * Plan a bulk credit or charge.
     *
     * o = { targets: [{ key, name }], kind: 'credit'|'charge', mode: 'each'|'split',
     *       amount, reason }
     *
     * `split` sums to EXACTLY the amount asked for. That is not a nicety: a camp-wide
     * 5,000 scholarship pot that distributes 4,999.98 has two cents nobody can
     * account for, and the pot no longer reconciles with what was granted.
     *
     * A reason is required. A bulk credit with no reason is indistinguishable from a
     * mistake a month later, and it is the entry most likely to be queried.
     */
    B.planBulkEntry = function (o) {
        o = o || {};
        var kind = str(o.kind) === 'charge' ? 'charge' : 'credit';
        var mode = str(o.mode) === 'split' ? 'split' : 'each';
        var reason = str(o.reason);
        var amount = money(o.amount);
        var targets = (Array.isArray(o.targets) ? o.targets : []).filter(function (t) {
            return t && str(t.key);
        });
        var out = { ok: false, reason: '', message: '', kind: kind, mode: mode,
                    entries: [], total: 0, count: 0, warnings: [] };

        if (!targets.length) {
            out.reason = 'no_targets';
            out.message = 'Nobody is selected.';
            return out;
        }
        if (!(amount > 0)) {
            out.reason = 'no_amount';
            out.message = 'Enter an amount above zero.';
            return out;
        }
        if (!reason) {
            out.reason = 'no_reason';
            out.message = 'Say what this is for. A bulk ' + kind
                        + ' with no reason is indistinguishable from a mistake.';
            return out;
        }

        if (mode === 'each') {
            targets.forEach(function (t) {
                out.entries.push({ key: str(t.key), name: str(t.name), amount: amount,
                                   reason: reason, kind: kind });
            });
            out.total = money(amount * targets.length);
        } else {
            var totalC = cents(amount);
            var baseC = Math.floor(totalC / targets.length);
            var remC = totalC - baseC * targets.length;
            if (baseC === 0) {
                // Splitting 3.00 between 400 families gives most of them nothing.
                // Say so rather than posting a pile of zero entries.
                out.reason = 'too_thin';
                out.message = 'Splitting ' + amount.toFixed(2) + ' between ' + targets.length
                            + ' accounts leaves most of them nothing. Raise the amount or '
                            + 'select fewer accounts.';
                return out;
            }
            targets.forEach(function (t, i) {
                // The odd pennies ride on the FIRST account, matching how an
                // installment plan splits, so the two never disagree by a penny.
                var c = baseC + (i === 0 ? remC : 0);
                out.entries.push({ key: str(t.key), name: str(t.name), amount: money(c / 100),
                                   reason: reason, kind: kind });
            });
            out.total = amount;
        }

        // There is deliberately NO post-hoc "did that sum correctly?" check here.
        // Working in integer cents and handing the remainder to one account makes the
        // sum exact BY CONSTRUCTION, so such a check could never fire — and a branch
        // that cannot fire is not a safeguard, it is unreachable code that reads like
        // one. The property is proved instead, across awkward ratios, in
        // tests/bulk.test.js ('a split always sums to exactly what was asked for').

        out.ok = true;
        out.reason = 'ok';
        out.count = out.entries.length;
        return out;
    };

    B.describeBulk = function (p) {
        if (!p || !p.ok || !p.count) return '';
        return (p.kind === 'charge' ? 'Charge ' : 'Credit ') + money(p.total).toFixed(2)
             + ' across ' + p.count + ' account' + (p.count === 1 ? '' : 's');
    };

    // ── 3. credits covering what is owed ──────────────────────────────────

    /**
     * Obligations that come first, because each one BLOCKS something until it is
     * settled — a place held, a form accepted, a seat on the bus. Clearing a
     * deposit with money the family has already given us is the difference between
     * a camper being enrolled today and a parent being asked for money twice.
     */
    B.PRIORITY_KINDS = { deposit: 1, registration: 1, fee: 2 };

    /**
     * Plan applying a credit balance against what a family owes.
     *
     * o = { credit, obligations: [{ id, label, kind, amount, paid, dueDate }] }
     *
     * Order: blocking kinds first (deposit, registration, then other fees), then
     * oldest due date, then the order given. Never more than the credit, never more
     * than an obligation actually owes.
     */
    B.planCoverage = function (o) {
        o = o || {};
        var credit = money(o.credit);
        var obs = (Array.isArray(o.obligations) ? o.obligations : []).filter(function (x) {
            return x && str(x.id) && money(money(x.amount) - money(x.paid)) > 0;
        });
        var out = { ok: true, applications: [], applied: 0, leftover: money(credit),
                    covered: [], partial: null, warnings: [] };

        if (!(credit > 0) || !obs.length) {
            if (!(credit > 0)) out.warnings.push('There is no credit on this account.');
            else out.warnings.push('Nothing is outstanding for the credit to cover.');
            out.ok = false;
            return out;
        }

        var order = obs.map(function (x, i) { return { x: x, i: i }; });
        order.sort(function (a, b) {
            var pa = B.PRIORITY_KINDS[str(a.x.kind)] || 9;
            var pb = B.PRIORITY_KINDS[str(b.x.kind)] || 9;
            if (pa !== pb) return pa - pb;
            var da = str(a.x.dueDate), db = str(b.x.dueDate);
            // A missing due date sorts LAST, not first: an undated obligation is not
            // evidence of being the oldest, and treating it as such would jump it
            // ahead of a deposit that really is overdue.
            if (da !== db) {
                if (!da) return 1;
                if (!db) return -1;
                return da < db ? -1 : 1;
            }
            return a.i - b.i;
        });

        var left = credit;
        order.forEach(function (w) {
            if (left <= 0) return;
            var x = w.x;
            var owed = money(money(x.amount) - money(x.paid));
            var use = Math.min(owed, left);
            use = money(use);
            if (!(use > 0)) return;
            var full = use === owed;
            out.applications.push({ id: str(x.id), label: str(x.label) || str(x.id),
                                    kind: str(x.kind), amount: use, owed: owed, full: full });
            if (full) out.covered.push(str(x.id));
            else out.partial = str(x.id);
            left = money(left - use);
        });

        out.applied = money(credit - left);
        out.leftover = left;
        if (out.leftover > 0) {
            out.warnings.push(out.leftover.toFixed(2) + ' of the credit is left over and '
                + 'stays on the account.');
        }
        out.ok = out.applications.length > 0;
        return out;
    };

    B.describeCoverage = function (p) {
        if (!p || !p.applications || !p.applications.length) return '';
        var n = p.applications.length;
        return money(p.applied).toFixed(2) + ' against ' + n + ' item' + (n === 1 ? '' : 's')
             + (p.leftover > 0 ? ' · ' + money(p.leftover).toFixed(2) + ' left on account' : '');
    };

    // ── 4. late fees, actually applied ────────────────────────────────────

    /**
     * Filter late-fee proposals against what has already been applied.
     *
     * campistry_ar.js builds every proposal's key from the invoice AND the period
     * number, so running September twice proposes the same key twice and running
     * October proposes a new one. That design only means anything if somebody checks
     * the key, and this is the check: `applied` is the camp's record of keys already
     * posted.
     *
     * A fee is money taken from a family. Being asked twice for it because an office
     * clicked a button twice is not a rounding error, and "we'll notice" is not a
     * control.
     */
    B.planLateFees = function (o) {
        o = o || {};
        var proposals = Array.isArray(o.proposals) ? o.proposals : [];
        var applied = o.applied || {};
        var out = { ok: false, toApply: [], alreadyApplied: [], total: 0, count: 0 };
        var seen = {};

        proposals.forEach(function (p) {
            if (!p) return;
            var key = str(p.key);
            var amt = money(p.amount);
            if (!key || !(amt > 0)) return;
            // Applied before, or proposed twice within this same run — the second is
            // just as capable of double-charging as the first.
            if (applied[key] || seen[key]) {
                out.alreadyApplied.push(Object.assign({}, p, { amount: amt }));
                return;
            }
            seen[key] = 1;
            out.toApply.push(Object.assign({}, p, { amount: amt }));
            out.total = money(out.total + amt);
        });

        out.count = out.toApply.length;
        out.ok = out.count > 0;
        return out;
    };

    /** The record a caller keeps so the next run can refuse the same fee. */
    B.recordLateFees = function (applied, plan, on) {
        var next = Object.assign({}, applied || {});
        ((plan && plan.toApply) || []).forEach(function (p) {
            if (p && str(p.key)) next[str(p.key)] = str(on) || 1;
        });
        return next;
    };

    B.describeLateFees = function (p) {
        if (!p) return '';
        if (!p.count) {
            return p.alreadyApplied && p.alreadyApplied.length
                ? 'Already applied — nothing new to charge.'
                : 'Nothing is late enough to charge a fee on.';
        }
        return p.count + ' fee' + (p.count === 1 ? '' : 's') + ' · '
             + money(p.total).toFixed(2)
             + (p.alreadyApplied.length ? ' (' + p.alreadyApplied.length + ' already applied)' : '');
    };

    // ── 5. telling the family ─────────────────────────────────────────────

    /**
     * Who a bulk send can actually reach.
     *
     * An invoice nobody is told about is not an invoice, so a run that marks
     * installments invoiced and silently reaches nobody is worse than one that
     * refuses: the office believes it has asked, and the family has not been asked.
     * This names both halves.
     *
     * o = { kind: 'invoice'|'statement',
     *       recipients: [{ key, name, emails: [...] }] }
     *
     * Addresses are deduplicated WITHIN a household, because two parents sharing an
     * inbox should get one copy — but NOT across households, because two families
     * can legitimately share an address (a grandparent paying for both) and each is
     * owed their own document.
     */
    B.planSend = function (o) {
        o = o || {};
        var kind = str(o.kind) === 'statement' ? 'statement' : 'invoice';
        var list = Array.isArray(o.recipients) ? o.recipients : [];
        var out = { ok: false, kind: kind, send: [], noEmail: [], count: 0, addresses: 0 };

        list.forEach(function (r) {
            if (!r || !str(r.key)) return;
            var seen = {}, to = [];
            (Array.isArray(r.emails) ? r.emails : []).forEach(function (e) {
                var raw = str(e);
                // The bar is deliberately low — one @ with something either side.
                // A stricter pattern here would silently drop addresses that the
                // mail provider would have delivered to perfectly well, and a
                // dropped invoice looks exactly like a family who ignored one.
                if (!/^[^@\s]+@[^@\s]+$/.test(raw)) return;
                var k = raw.toLowerCase();
                if (seen[k]) return;
                seen[k] = 1;
                to.push(raw);
            });
            if (!to.length) {
                out.noEmail.push({ key: str(r.key), name: str(r.name) });
                return;
            }
            out.send.push({ key: str(r.key), name: str(r.name), to: to, kind: kind });
            out.addresses += to.length;
        });

        out.count = out.send.length;
        out.ok = out.count > 0;
        return out;
    };

    B.describeSend = function (p) {
        if (!p) return '';
        if (!p.count) {
            return p.noEmail && p.noEmail.length
                ? 'Nobody on this list has an email address on file.'
                : 'Nobody to send to.';
        }
        var bits = [p.count + ' famil' + (p.count === 1 ? 'y' : 'ies')];
        if (p.addresses !== p.count) bits.push(p.addresses + ' addresses');
        if (p.noEmail.length) bits.push(p.noEmail.length + ' with no email');
        return bits.join(' \u00b7 ');
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = B;
    if (root) root.CampistryBulk = B;
})(typeof window !== 'undefined' ? window : null);
