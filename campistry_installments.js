/* =============================================================================
 * campistry_installments.js — a payment plan that advances PER FAMILY, when they
 * are invoiced, rather than on a calendar decided at enrolment.
 *
 * WHAT WE DID BEFORE. _buildInstallmentSchedule stamped dates at enrolment: today,
 * today + 30, today + 60. The schedule was a fixed calendar computed once, from
 * whenever the family happened to apply.
 *
 * Two things go wrong with that, and both are ordinary rather than exotic:
 *
 *   * A FAMILY WHO JOINS IN MAY gets "payment 1 of 3" due in May, 2 in June, 3 in
 *     July. A family who joins in February gets February, March, April. Same plan,
 *     different months, and no month on which the office can say "run the second
 *     installment" — because there isn't one, there are as many as there are
 *     application dates.
 *   * A CAMP THAT BILLS LATE, or skips a month, or takes a week off, has a schedule
 *     saying money was due on a date nothing happened on. The dates drift away from
 *     what was actually collected, and the schedule stops describing reality.
 *
 * WHAT CAMPMINDER DOES, AND WHAT THIS NOW DOES. The installment counter belongs to
 * the FAMILY and moves when they are INVOICED. An office runs an installment; every
 * family included in that run advances to their next one. Nobody advances because a
 * date passed. So:
 *
 *   * a family who joins in May is simply on installment 1 like everyone else, and
 *     catches up as the camp bills;
 *   * a camp that bills late has billed late — the schedule still says exactly what
 *     has been invoiced and what has not, because invoicing is the event;
 *   * two families on the same plan can legitimately sit on different installments,
 *     which is the thing a calendar model cannot represent at all.
 *
 * `dueDate` survives as GUIDANCE — what the office intended, useful for a reminder
 * and for aging — but it no longer decides anything. The event does.
 *
 * ── AND A CAMP CAN TURN PLANS OFF ENTIRELY ─────────────────────────────────
 *
 * Some camps want tuition in full, full stop. `plan` is a method in
 * campistry_payments.js like any other, so unticking it in Accepted payments must
 * actually mean no plans — not a plan that is offered and then refused. Ask
 * plansAllowed() before building a schedule at all.
 *
 * Pure. It plans and reads; it writes nothing.
 * ========================================================================== */
(function (root) {
    'use strict';
    var I = {};

    function money(n) {
        var v = Math.round((Number(n) || 0) * 100) / 100;
        return Number.isFinite(v) ? v : 0;
    }
    function cents(n) { return Math.round((Number(n) || 0) * 100); }
    function str(s) { return String(s == null ? '' : s).trim(); }

    /** An installment's life: waiting, billed, settled. */
    I.STATUSES = { pending: 1, invoiced: 1, paid: 1 };

    /**
     * The payment catalogue. Injectable, because this module is loaded both in a
     * browser — where it is a global — and by tests and any future server-side
     * caller, where it is a require() away and there is no window to hang it on.
     * Without the second path "plans are off" could never be tested at all.
     */
    var _catalogue = null;
    I.useCatalogue = function (P) { _catalogue = P || null; return I; };
    function catalogue(given) {
        if (given && typeof given.forContext === 'function') return given;
        if (_catalogue && typeof _catalogue.forContext === 'function') return _catalogue;
        try {
            var P = (typeof root !== 'undefined' && root && root.CampistryPayments) || null;
            if (P && typeof P.forContext === 'function') return P;
        } catch (e) {}
        return null;
    }

    /**
     * Does this camp allow payment plans at all?
     *
     * Reads the one camp-wide catalogue, so unticking "Payment plan" in Accepted
     * payments is the whole switch. NO catalogue means yes — that is how it behaved
     * before the catalogue existed, and a camp should not lose payment plans because
     * a script tag is missing.
     */
    I.plansAllowed = function (policyRaw, payments) {
        try {
            var P = catalogue(payments);
            if (!P) return true;
            return P.forContext('tuition', policyRaw).some(function (m) { return m.id === 'plan'; });
        } catch (e) { return true; }
    };

    /**
     * Build the schedule for a session's plan. Returns null when there is no plan —
     * which includes a camp that has turned plans off.
     *
     * The amounts are split in CENTS and the remainder goes on the FIRST
     * installment, not the last. A family paying £333.34 now and £333.33 twice has
     * paid the odd penny early; the other way round leaves a penny outstanding at
     * the end of the summer, which is the kind of balance somebody has to chase.
     */
    I.build = function (o) {
        o = o || {};
        var ses = o.session || {};
        var tuition = money(o.tuition);
        if (!I.plansAllowed(o.policy, o.payments)) return null;

        var plan = str(ses.paymentPlan);
        if (!plan || plan === 'full') return null;
        if (!(tuition > 0)) return null;

        var out = [];
        if (plan === 'deposit') {
            var dep = money(ses.depositAmount) || money(tuition * 0.25);
            if (dep > tuition) dep = tuition;
            out.push({ n: 1, of: 2, label: 'Down payment', amount: dep,
                       dueDate: str(o.today) || I.today(), status: 'pending' });
            var rest = money(tuition - dep);
            if (rest > 0) {
                out.push({ n: 2, of: 2, label: 'Remaining tuition', amount: rest,
                           dueDate: str(ses.startDate), status: 'pending' });
            }
            out.forEach(function (x) { x.of = out.length; });
            return out;
        }

        var num = parseInt(plan, 10) || 2;
        if (num < 1) num = 1;
        var totalC = cents(tuition);
        var baseC = Math.floor(totalC / num);
        var remC = totalC - baseC * num;
        var start = str(o.today) || I.today();
        for (var i = 0; i < num; i++) {
            out.push({
                n: i + 1, of: num,
                label: 'Payment ' + (i + 1) + ' of ' + num,
                // The odd pennies ride on the FIRST payment.
                amount: money((baseC + (i === 0 ? remC : 0)) / 100),
                dueDate: I.addDays(start, 30 * i),
                status: 'pending'
            });
        }
        return out;
    };

    I.today = function () {
        var d = new Date();
        return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    };
    I.addDays = function (ymd, n) {
        var d = new Date(str(ymd) + 'T00:00:00Z');
        if (isNaN(d.getTime())) return str(ymd);
        d.setUTCDate(d.getUTCDate() + (Number(n) || 0));
        return d.toISOString().slice(0, 10);
    };

    /**
     * Where is this family up to? The first installment not yet invoiced.
     *
     * Returns { index, installment, done } — `done` when every one has been
     * invoiced, which is how a caller knows to stop including them in runs.
     */
    I.current = function (schedule) {
        var list = Array.isArray(schedule) ? schedule : [];
        for (var i = 0; i < list.length; i++) {
            var s = list[i];
            if (!s) continue;
            if (str(s.status) === 'pending') return { index: i, installment: s, done: false };
        }
        return { index: -1, installment: null, done: list.length > 0 };
    };

    /**
     * Invoice the family's next installment. THIS is what advances them.
     *
     * Returns { ok, index, installment, schedule } with a NEW schedule array — the
     * caller stores it. Refuses when there is nothing left, rather than inventing an
     * extra installment, because a plan that can grow by being run again is a plan
     * that bills a family forever.
     */
    I.invoiceNext = function (schedule, o) {
        o = o || {};
        var list = (Array.isArray(schedule) ? schedule : []).map(function (s) {
            return Object.assign({}, s);
        });
        var cur = I.current(list);
        if (cur.index < 0) {
            return { ok: false, reason: list.length ? 'all_invoiced' : 'no_schedule',
                     message: list.length
                        ? 'Every installment on this plan has already been invoiced.'
                        : 'This family is not on a payment plan.',
                     index: -1, installment: null, schedule: list };
        }
        var when = str(o.on) || I.today();
        list[cur.index].status = 'invoiced';
        list[cur.index].invoicedAt = when;
        // What the office MEANT is kept; what actually happened is recorded beside
        // it. Overwriting dueDate would erase the fact that the camp billed late.
        if (o.dueDate) list[cur.index].invoiceDueDate = str(o.dueDate);
        return { ok: true, reason: 'ok', message: '', index: cur.index,
                 installment: list[cur.index], schedule: list };
    };

    /** Mark an invoiced installment settled. */
    I.markPaid = function (schedule, index, on) {
        var list = (Array.isArray(schedule) ? schedule : []).map(function (s) {
            return Object.assign({}, s);
        });
        var i = Number(index);
        if (!list[i]) return { ok: false, reason: 'no_such_installment', schedule: list };
        list[i].status = 'paid';
        list[i].paidAt = str(on) || I.today();
        return { ok: true, reason: 'ok', schedule: list };
    };

    /**
     * What has been invoiced and not yet paid — the money actually owed right now.
     *
     * NOT "what a date says is due". An installment nobody invoiced is not owed yet,
     * however long ago its dueDate was, because the family was never asked. That
     * distinction is the whole difference between this model and a calendar, and it
     * is what makes aging honest: a family is late because they were billed and did
     * not pay, not because a date in a schedule slipped by while the office was busy.
     */
    I.owedNow = function (schedule) {
        var list = Array.isArray(schedule) ? schedule : [];
        var total = 0, items = [];
        list.forEach(function (s, i) {
            if (!s || str(s.status) !== 'invoiced') return;
            total += money(s.amount);
            items.push({ index: i, installment: s });
        });
        return { total: money(total), items: items };
    };

    /** A progress line: "Payment 2 of 4 · 1 invoiced, 1 paid". */
    I.describe = function (schedule) {
        var list = Array.isArray(schedule) ? schedule : [];
        if (!list.length) return '';
        var paid = 0, inv = 0;
        list.forEach(function (s) {
            if (!s) return;
            if (str(s.status) === 'paid') paid++;
            else if (str(s.status) === 'invoiced') inv++;
        });
        var cur = I.current(list);
        var head = cur.done ? 'All ' + list.length + ' invoiced'
                            : 'Next: ' + (cur.installment.label || ('Payment ' + (cur.index + 1)));
        var bits = [];
        if (inv) bits.push(inv + ' awaiting payment');
        if (paid) bits.push(paid + ' paid');
        return bits.length ? (head + ' · ' + bits.join(', ')) : head;
    };

    /**
     * The total of a schedule, which must equal the tuition it was built from.
     * Exposed so a caller can assert it rather than trust it.
     */
    I.total = function (schedule) {
        return money((Array.isArray(schedule) ? schedule : []).reduce(function (n, s) {
            return n + money(s && s.amount);
        }, 0));
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = I;
    if (root) root.CampistryInstallments = I;
})(typeof window !== 'undefined' ? window : null);
