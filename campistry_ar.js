/* =============================================================================
 * campistry_ar.js — what is owed, how late it is, and what to do about it.
 *
 * Five things that turned out to be one domain, which is why they are one file:
 * an invoice is not a statement, aging is what makes "past due" mean anything, a
 * late fee is assessed against an aged invoice, a write-off ends one, and the
 * who-owes-me question is a query over all of it.
 *
 * ── AN INVOICE IS NOT A STATEMENT ──────────────────────────────────────────
 *
 * We only ever had statements. A STATEMENT says where an account stands: here is
 * what you were charged, what you paid, what is left. It asks for nothing. An
 * INVOICE says a specific amount is due by a specific date, and it is the thing
 * that starts a clock.
 *
 * The distinction is not cosmetic. Without it there is no answer to "how late is
 * this" — a statement has no due date to be late against, so "60 days past due"
 * cannot be computed, which is why the aging report did not exist. Every question
 * below hangs off the invoice being a real object with a date on it.
 *
 * ── AGING IS FROM WHAT WAS INVOICED, NOT FROM WHAT A SCHEDULE SAID ─────────
 *
 * The same principle campistry_installments.js runs on: a family is late because
 * they were ASKED and did not pay, not because a date in a schedule slipped by
 * while the office was busy. An installment nobody invoiced is not overdue however
 * old its dueDate is — nobody ever asked for it.
 *
 * This matters most in the direction that looks wrong at first. A camp that forgot
 * to bill for two months has families who owe nothing yet, not families who are 60
 * days late. Aging them would put the camp's own delay on the family's record, and
 * on any letter that record generates.
 *
 * ── A LATE FEE IS A CHARGE, AND MUST BE ASSESSED ONCE ──────────────────────
 *
 * Nothing here writes, but `assess` returns a key for every fee it proposes,
 * derived from the invoice and the period — so running the month twice proposes the
 * same key twice and the caller's own dedupe refuses the second. A late fee applied
 * on every render is a family billed forever, and this codebase has met that shape
 * before.
 *
 * Pure. It answers questions and proposes charges; it writes nothing.
 * ========================================================================== */
(function (root) {
    'use strict';
    var A = {};

    function money(n) {
        var v = Math.round((Number(n) || 0) * 100) / 100;
        return Number.isFinite(v) ? v : 0;
    }
    function str(s) { return String(s == null ? '' : s).trim(); }
    function ymd(d) {
        var s = str(d);
        return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
    }
    function today() {
        var d = new Date();
        return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    }
    A.today = today;

    /** Whole days between two dates, positive when `b` is later. */
    A.daysBetween = function (a, b) {
        var x = ymd(a), y = ymd(b);
        if (!x || !y) return 0;
        return Math.round((Date.parse(y + 'T00:00:00Z') - Date.parse(x + 'T00:00:00Z'))
                          / 86400000);
    };

    // ── the two documents ──────────────────────────────────────────────────

    /**
     * The two kinds, and what each one claims.
     *
     * `asks` is the whole difference: an invoice asks for money by a date, a
     * statement reports a position. Anything that computes lateness may only look at
     * documents that ask.
     */
    A.DOC_KINDS = [
        { id: 'invoice',   label: 'Invoice',   asks: true,
          blurb: 'A specific amount, due by a specific date.' },
        { id: 'statement', label: 'Statement', asks: false,
          blurb: 'Where the account stands. Asks for nothing.' }
    ];
    A.asks = function (kind) {
        var k = A.DOC_KINDS.filter(function (d) { return d.id === str(kind); })[0];
        return !!(k && k.asks);
    };

    /** How long a camp gives families to pay. 30 days is the ordinary default. */
    A.DEFAULT_TERMS_DAYS = 30;

    /**
     * Build an invoice or a statement for a family.
     *
     * An invoice gets a due date — from `dueDate` if the office set one, otherwise
     * issue date plus the camp's terms. A STATEMENT NEVER GETS ONE, and that is
     * enforced rather than left to the caller: a statement carrying a due date would
     * age, and a document that asks for nothing cannot be late.
     */
    A.buildDoc = function (o) {
        o = o || {};
        var kind = A.asks(o.kind) ? 'invoice' : 'statement';
        var issued = ymd(o.issuedOn) || today();
        var terms = Number(o.termsDays);
        if (!Number.isFinite(terms) || terms < 0) terms = A.DEFAULT_TERMS_DAYS;

        var doc = {
            id: str(o.id) || (kind + '_' + Date.now()),
            kind: kind,
            familyKey: str(o.familyKey),
            issuedOn: issued,
            amount: money(o.amount),
            lines: Array.isArray(o.lines) ? o.lines.slice() : [],
            note: str(o.note),
            status: 'open'
        };
        if (kind === 'invoice') {
            doc.dueDate = ymd(o.dueDate) || A.addDays(issued, terms);
            doc.termsDays = terms;
        }
        return doc;
    };

    A.addDays = function (d, n) {
        var s = ymd(d);
        if (!s) return '';
        var t = new Date(Date.parse(s + 'T00:00:00Z'));
        t.setUTCDate(t.getUTCDate() + (Number(n) || 0));
        return t.toISOString().slice(0, 10);
    };

    // ── aging ──────────────────────────────────────────────────────────────

    /** The buckets, in the order a report reads them. */
    A.BUCKETS = [
        { id: 'current', label: 'Not yet due', from: -Infinity, to: 0 },
        { id: 'd1_30',   label: '1–30 days', from: 1,  to: 30 },
        { id: 'd31_60',  label: '31–60 days', from: 31, to: 60 },
        { id: 'd61_90',  label: '61–90 days', from: 61, to: 90 },
        { id: 'd90p',    label: 'Over 90 days', from: 91, to: Infinity }
    ];

    A.bucketFor = function (daysLate) {
        var n = Number(daysLate) || 0;
        for (var i = 0; i < A.BUCKETS.length; i++) {
            var b = A.BUCKETS[i];
            if (n >= b.from && n <= b.to) return b.id;
        }
        return 'current';
    };

    /**
     * Age a family's OPEN INVOICES as of a date.
     *
     * Only invoices. Statements are skipped because they ask for nothing, and an
     * invoice that has been settled or written off is closed and no longer owed.
     *
     * Returns { total, buckets, oldestDays, items, pastDue } — `pastDue` being the
     * part that is actually late, which is the number a collections screen leads
     * with. `total` includes not-yet-due, because a family's balance is not only
     * what is overdue.
     */
    A.age = function (o) {
        o = o || {};
        var docs = Array.isArray(o.docs) ? o.docs : [];
        var asOf = ymd(o.asOf) || today();
        var out = { total: 0, pastDue: 0, oldestDays: 0, items: [], buckets: {} };
        A.BUCKETS.forEach(function (b) { out.buckets[b.id] = 0; });

        docs.forEach(function (d) {
            if (!d || !A.asks(d.kind)) return;
            if (str(d.status) !== 'open') return;
            var owed = money(d.amount) - money(d.paid);
            if (owed <= 0) return;
            var late = A.daysBetween(d.dueDate, asOf);
            var bucket = A.bucketFor(late);
            out.buckets[bucket] = money(out.buckets[bucket] + owed);
            out.total = money(out.total + owed);
            if (late > 0) {
                out.pastDue = money(out.pastDue + owed);
                if (late > out.oldestDays) out.oldestDays = late;
            }
            out.items.push({ id: d.id, owed: owed, dueDate: d.dueDate || '',
                             daysLate: late, bucket: bucket });
        });
        // Oldest first: a collections call starts with the worst one.
        out.items.sort(function (a, b) { return b.daysLate - a.daysLate; });
        return out;
    };

    /**
     * A short line for a family row: "420.00 past due · oldest 47 days".
     * Empty when nothing is late, so a clean account shows nothing at all.
     */
    A.describeAging = function (aged) {
        if (!aged || !aged.pastDue) return '';
        return aged.pastDue.toFixed(2) + ' past due · oldest '
             + aged.oldestDays + ' day' + (aged.oldestDays === 1 ? '' : 's');
    };

    // ── the who-owes-me query ──────────────────────────────────────────────

    /**
     * Find the families matching financial criteria — the inquiry an office actually
     * runs in August.
     *
     * `families` is [{ key, name, docs, lastPaymentOn }]. Criteria:
     *   minPastDue      at least this much actually late
     *   minDaysLate     nothing newer than this
     *   bucket          only families with money in this bucket
     *   noPaymentSince  nobody who has paid since this date
     *
     * Sorted worst-first, because that is the order the calls get made in.
     */
    A.inquire = function (o) {
        o = o || {};
        var fams = Array.isArray(o.families) ? o.families : [];
        var asOf = ymd(o.asOf) || today();
        var minPastDue = money(o.minPastDue);
        var minDaysLate = Number(o.minDaysLate) || 0;
        var bucket = str(o.bucket);
        var noPaymentSince = ymd(o.noPaymentSince);

        var rows = [];
        fams.forEach(function (f) {
            if (!f) return;
            var aged = A.age({ docs: f.docs, asOf: asOf });
            if (aged.pastDue < minPastDue) return;
            if (minPastDue > 0 && aged.pastDue <= 0) return;
            if (aged.oldestDays < minDaysLate) return;
            if (bucket && !(aged.buckets[bucket] > 0)) return;
            if (noPaymentSince) {
                var last = ymd(f.lastPaymentOn);
                // Never paid counts as matching: they are exactly who the query is
                // looking for, and treating a blank as "paid recently" would hide
                // the worst cases.
                if (last && A.daysBetween(noPaymentSince, last) > 0) return;
            }
            rows.push({ key: str(f.key), name: str(f.name), aging: aged,
                        lastPaymentOn: ymd(f.lastPaymentOn) });
        });
        rows.sort(function (a, b) {
            if (b.aging.pastDue !== a.aging.pastDue) return b.aging.pastDue - a.aging.pastDue;
            return b.aging.oldestDays - a.aging.oldestDays;
        });
        var totals = { pastDue: 0, total: 0, buckets: {} };
        A.BUCKETS.forEach(function (b) { totals.buckets[b.id] = 0; });
        rows.forEach(function (r) {
            totals.pastDue = money(totals.pastDue + r.aging.pastDue);
            totals.total = money(totals.total + r.aging.total);
            A.BUCKETS.forEach(function (b) {
                totals.buckets[b.id] = money(totals.buckets[b.id] + r.aging.buckets[b.id]);
            });
        });
        return { rows: rows, totals: totals, asOf: asOf };
    };

    // ── late fees ──────────────────────────────────────────────────────────

    /** No fees unless a camp turns them on. Nobody should be charged by default. */
    A.normalizeLateFeePolicy = function (p) {
        p = p || {};
        var mode = str(p.mode);
        if (mode !== 'percent' && mode !== 'flat') mode = 'off';
        return {
            mode: mode,
            percent: Math.max(0, Math.min(100, Number(p.percent) || 0)),
            flat: money(p.flat),
            graceDays: Math.max(0, Number(p.graceDays) || 0),
            minBalance: money(p.minBalance),
            maxPerInvoice: money(p.maxPerInvoice),
            // 'once' or 'monthly'. Monthly is how a percentage is normally stated,
            // and it is also the one that can run away, so it is capped above.
            frequency: str(p.frequency) === 'monthly' ? 'monthly' : 'once'
        };
    };

    /**
     * Propose late fees. Returns [{ key, docId, amount, periods, note }].
     *
     * Every proposal carries a KEY built from the invoice and the period number, so
     * running the month twice proposes the same key twice and the caller's dedupe
     * refuses the second. Nothing here writes; a fee applied on every render is a
     * family billed forever.
     */
    A.assessLateFees = function (o) {
        o = o || {};
        var pol = A.normalizeLateFeePolicy(o.policy);
        if (pol.mode === 'off') return [];
        var asOf = ymd(o.asOf) || today();
        var out = [];

        (Array.isArray(o.docs) ? o.docs : []).forEach(function (d) {
            if (!d || !A.asks(d.kind) || str(d.status) !== 'open') return;
            var owed = money(money(d.amount) - money(d.paid));
            if (owed <= 0) return;
            if (pol.minBalance > 0 && owed < pol.minBalance) return;

            var late = A.daysBetween(d.dueDate, asOf) - pol.graceDays;
            if (late <= 0) return;

            // Monthly means one period per completed 30 days past grace, and at least
            // one — a fee for month 1 is due the moment grace ends.
            var periods = (pol.frequency === 'monthly') ? Math.max(1, Math.ceil(late / 30)) : 1;

            var per = (pol.mode === 'percent') ? money(owed * pol.percent / 100) : pol.flat;
            if (!(per > 0)) return;
            var amount = money(per * periods);
            if (pol.maxPerInvoice > 0 && amount > pol.maxPerInvoice) amount = pol.maxPerInvoice;
            if (!(amount > 0)) return;

            out.push({
                // The period is IN the key, so next month proposes a new fee and this
                // month proposes the same one it already did.
                key: 'lf_' + str(d.id) + '_p' + periods,
                docId: str(d.id), amount: amount, periods: periods, daysLate: late,
                note: 'Late fee — ' + (pol.mode === 'percent'
                        ? (pol.percent + '% of ' + owed.toFixed(2))
                        : ('flat ' + pol.flat.toFixed(2)))
                    + (periods > 1 ? ' × ' + periods + ' months' : '')
            });
        });
        return out;
    };

    // ── writing one off ────────────────────────────────────────────────────

    /**
     * Plan a write-off. Returns { ok, reason, message, steps }.
     *
     * A write-off is a CREDIT with a reason, not a deletion and not an edit — the
     * ledger is immutable and the camp needs to be able to report what it gave up on.
     * The invoice is closed as `written_off` rather than `paid`, because those are
     * different facts and a report that conflates them overstates collections.
     */
    A.planWriteOff = function (o) {
        o = o || {};
        var doc = o.doc || null;
        var reason = str(o.reason);
        if (!doc || !doc.id) {
            return { ok: false, reason: 'no_invoice', message: 'That invoice could not be found.', steps: [] };
        }
        if (!A.asks(doc.kind)) {
            return { ok: false, reason: 'not_an_invoice',
                     message: 'A statement asks for nothing, so there is nothing to write off.',
                     steps: [] };
        }
        if (str(doc.status) !== 'open') {
            return { ok: false, reason: 'not_open',
                     message: 'That invoice is already ' + str(doc.status) + '.', steps: [] };
        }
        var owed = money(money(doc.amount) - money(doc.paid));
        if (owed <= 0) {
            return { ok: false, reason: 'nothing_owed',
                     message: 'Nothing is outstanding on that invoice.', steps: [] };
        }
        if (!reason) {
            return { ok: false, reason: 'no_reason',
                     message: 'Say why it is being written off. A write-off with no reason '
                            + 'is indistinguishable from a mistake.', steps: [] };
        }
        return {
            ok: true, reason: 'ok', message: '', amount: owed,
            steps: [
                { do: 'credit', amount: owed, ledgerReason: 'write_off',
                  note: 'Written off — ' + reason, docId: str(doc.id) },
                { do: 'close', docId: str(doc.id), status: 'written_off', note: reason }
            ]
        };
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = A;
    if (root) root.CampistryAR = A;
})(typeof window !== 'undefined' ? window : null);
