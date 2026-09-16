/* =============================================================================
 * campistry_tax_statement.js — what a family PAID in one calendar year, per
 * child, split into what a parent may claim and what they may not.
 *
 * WHY THIS EXISTS. Every January a camp office gets the same email from every
 * family: "I need the form for my taxes." The parent is filling in IRS Form
 * 2441 (Child and Dependent Care Expenses), and to do it they need four things
 * from the camp — the provider's name and address, the camp's EIN, the amount
 * PAID during the year, and that amount broken out PER CHILD, because Form 2441
 * is filled in one qualifying person at a time.
 *
 * Campistry already had a Print Statement, and it answers none of those
 * questions. It is an all-time account history ending in a BALANCE DUE — what
 * is still owed, which is the opposite of what was paid — with no year window,
 * no per-child split, and no distinction between money that counts as care and
 * money that does not. A parent handed it cannot fill in their return, and an
 * office trying to help ends up adding payments up by hand in a spreadsheet,
 * once per family, every January.
 *
 * WHAT THIS GETS RIGHT THAT ADDING UP PAYMENTS DOES NOT
 *
 *   PAID, NOT BILLED. Only payments count, net of refunds, and only in the
 *     window. A charge the family has not paid is not an expense they incurred;
 *     a discount is not money they spent. Both are excluded and both are shown,
 *     so nobody thinks the number is wrong.
 *
 *   PAYMENTS ARE APPLIED, OLDEST CHARGE FIRST. A family pays one lump into one
 *     account; the return needs it split per child. Dividing the year's
 *     payments pro rata across the year's charges is the obvious method and it
 *     is wrong in the two cases that actually turn up: a family who pays a
 *     deposit in December for next summer, and a family paying off last
 *     summer's arrears. So payments are applied FIFO against the open charges
 *     in date order — the way an account works anywhere — and each payment
 *     carries the child and the kind of charge it landed on.
 *
 *   PREPAYMENT IS NOT DEDUCTIBLE YET. Publication 503 is explicit: expenses
 *     paid before the care is given count in the year the care is GIVEN. A
 *     December deposit for next July is money paid this year that belongs on
 *     next year's return. FIFO finds it for free — it is whatever is left over
 *     when every charge on the books has been covered — and it is reported on
 *     its own line rather than folded into the total. Arrears are the mirror
 *     case and go the other way: paying in March for last summer counts NOW,
 *     in the year paid, and FIFO lands it on last summer's charges where it
 *     belongs.
 *
 *   OVERNIGHT CAMP NEVER QUALIFIES. Pub 503 again, and it is the single most
 *     common mistake on a camp's year-end letter. Sessions flagged `overnight`
 *     are reported, separately, as not claimable.
 *
 *   WHAT WE ARE NOT SURE ABOUT, WE DO NOT GUESS. Canteen top-ups, swag and
 *     photos are not care. Extended day and a camp-operated bus are. An add-on
 *     category nobody recognises goes in a `review` list with its amount, for
 *     the office to place — it is never silently counted and never silently
 *     dropped.
 *
 * Pure: it takes ledger entries and returns a report. It does not read app
 * state, does not print, and does not decide anything an office has not
 * configured. The statement itself is rendered by the caller.
 * ========================================================================== */
(function (root) {
    'use strict';
    var T = {};

    function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
    function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
    function ymd(d) { return String(d || '').slice(0, 10); }

    // ── which charges are care, and which are not ──────────────────────────
    // Matched against the entry's category first, then its description. The
    // office can override the whole thing by passing `rules`.
    T.DEFAULT_RULES = {
        // Care. Tuition and the things a camp bills alongside it that Pub 503
        // treats as part of the care: before/after care, and transport the
        // PROVIDER operates (a camp bus qualifies; the parent's own driving
        // does not, but the parent's own driving is not on our ledger).
        qualifying: [
            /\btuition\b/i, /camp\s*fee/i, /program\s*fee/i, /session\s*fee/i,
            /extended\s*day/i, /after[\s-]*care/i, /before[\s-]*care/i,
            /early\s*drop/i, /late\s*pick/i,
            /\bbus\b/i, /transport/i, /shuttle/i,
            /registration\s*fee/i, /deposit/i
        ],
        // Not care. Goods and incidentals the family bought at camp.
        notQualifying: [
            /canteen/i, /snack/i, /\bshop\b/i, /swag/i, /merch/i, /store/i,
            /photo/i, /\btip\b/i, /gratuity/i, /donation/i, /fundrais/i,
            /late\s*fee/i, /\bnsf\b/i, /returned/i, /insurance/i, /laundry/i
        ]
    };

    /**
     * Is this charge a care expense? Returns 'yes' | 'no' | 'review'.
     * `overnight` short-circuits to 'no' whatever the category says.
     */
    T.classifyCharge = function (entry, opts) {
        opts = opts || {};
        if (opts.overnight) return { verdict: 'no', reason: 'overnight' };
        var rules = opts.rules || T.DEFAULT_RULES;
        var hay = String((entry && entry.category) || '') + ' ' + String((entry && entry.desc) || '');
        var i;
        for (i = 0; i < (rules.notQualifying || []).length; i++) {
            if (rules.notQualifying[i].test(hay)) return { verdict: 'no', reason: 'not_care' };
        }
        for (i = 0; i < (rules.qualifying || []).length; i++) {
            if (rules.qualifying[i].test(hay)) return { verdict: 'yes', reason: 'care' };
        }
        return { verdict: 'review', reason: 'unrecognised' };
    };

    // ── the FIFO account ───────────────────────────────────────────────────
    // Charges become open lots in date order. Credits and payments consume
    // them oldest first. Every consumption records which lot it landed on, so
    // a payment can be traced to a child and to a kind of charge.
    function buildLots(entries, resolve, rules) {
        var lots = [];
        entries.forEach(function (e, idx) {
            if (!e || e.type !== 'charge') return;
            var amt = round2(num(e.amount));
            if (amt <= 0) return;
            var who = resolve(e) || {};
            var cls = T.classifyCharge(e, { overnight: who.overnight, rules: rules });
            lots.push({
                date: ymd(e.date), seq: idx, open: amt, amount: amt,
                camperName: who.camperName || '', session: who.session || '',
                qualifies: cls.verdict, why: cls.reason,
                label: e.desc || e.category || 'Charge', ref: e.ref || ''
            });
        });
        // Undated charges sort first: they are older than anything we can date,
        // and leaving them last would let a payment skip past them.
        lots.sort(function (a, b) {
            return (a.date || '').localeCompare(b.date || '') || (a.seq - b.seq);
        });
        return lots;
    }

    /** Consume `amount` from the open lots, oldest first. Returns the split. */
    function apply(lots, amount) {
        var left = round2(amount), hits = [];
        for (var i = 0; i < lots.length && left > 0.004; i++) {
            if (lots[i].open <= 0.004) continue;
            var take = Math.min(lots[i].open, left);
            lots[i].open = round2(lots[i].open - take);
            left = round2(left - take);
            hits.push({ lot: lots[i], amount: round2(take) });
        }
        return { hits: hits, unapplied: round2(Math.max(0, left)) };
    }

    /**
     * The year-end report.
     *
     * o = {
     *   year: 2026,
     *   entries: [ledger entries],                  // charge/credit/payment
     *   resolveCharge: fn(entry) -> {camperName, session, overnight}
     *   campers: { 'Eli Klein': {dob:'2014-06-01'} },
     *   rules: T.DEFAULT_RULES
     * }
     */
    T.build = function (o) {
        o = o || {};
        var year = String(o.year || new Date().getFullYear());
        var entries = Array.isArray(o.entries) ? o.entries : [];
        var campers = o.campers || {};
        var resolve = typeof o.resolveCharge === 'function' ? o.resolveCharge : function () { return {}; };
        var rules = o.rules || T.DEFAULT_RULES;

        var report = {
            year: Number(year),
            paid: { gross: 0, refunds: 0, net: 0 },
            qualifying: 0, notQualifying: 0, needsReview: 0,
            prepaid: 0,
            byCamper: [], review: [], excluded: [],
            undated: { count: 0, amount: 0 },
            uncollected: { count: 0, amount: 0 },
            warnings: [], allocated: true
        };

        // Money that is on the ledger but cannot be placed in a year at all.
        // Silently dropping it is how a total comes out short and nobody can
        // say why, so it is counted and named.
        var dated = [];
        entries.forEach(function (e) {
            if (!e || e.type === 'installment') return;   // a schedule, not money
            if (!ymd(e.date)) {
                if (e.type === 'payment') {
                    report.undated.count++;
                    report.undated.amount = round2(report.undated.amount + num(e.amount));
                }
                return;
            }
            dated.push(e);
        });

        var lots = buildLots(dated, resolve, rules);

        // Reducers — credits then payments — in date order. A credit satisfies
        // a charge exactly as a payment does; leaving them out would make a
        // discounted charge look unpaid and pull the next payment onto it.
        var reducers = dated.filter(function (e) {
            return e.type === 'credit' || e.type === 'payment';
        }).map(function (e, i) { return { e: e, i: i }; });
        reducers.sort(function (a, b) {
            return ymd(a.e.date).localeCompare(ymd(b.e.date)) ||
                   ((a.e.type === 'credit' ? 0 : 1) - (b.e.type === 'credit' ? 0 : 1)) ||
                   (a.i - b.i);
        });

        var perCamper = {}, reviewLines = {}, excludedLines = {};
        function bucket(name) {
            var k = name || '(unassigned)';
            if (!perCamper[k]) perCamper[k] = { camperName: k, qualifying: 0, notQualifying: 0, needsReview: 0, total: 0, notes: [] };
            return perCamper[k];
        }
        function note(map, key, amount) {
            if (!map[key]) map[key] = { label: key, amount: 0 };
            map[key].amount = round2(map[key].amount + amount);
        }

        var inYearRefunds = 0;
        reducers.forEach(function (r) {
            var e = r.e, amt = num(e.amount);
            var isPayment = e.type === 'payment';
            var inYear = ymd(e.date).slice(0, 4) === year;

            // A payment that never cleared is not money the family spent.
            if (isPayment && (e.status === 'pending' || e.status === 'failed')) {
                if (inYear) {
                    report.uncollected.count++;
                    report.uncollected.amount = round2(report.uncollected.amount + amt);
                }
                return;
            }

            // Refunds arrive as negative payments. They do not un-apply a
            // specific charge — nothing on the ledger says which one — so they
            // come off the year's total, pro rata, at the end.
            if (amt < 0) {
                if (isPayment && inYear) inYearRefunds = round2(inYearRefunds + Math.abs(amt));
                return;
            }

            var res = apply(lots, amt);
            if (!isPayment || !inYear) return;    // credits, and other years' payments, only move the lots

            report.paid.gross = round2(report.paid.gross + amt);
            res.hits.forEach(function (h) {
                var b = bucket(h.lot.camperName);
                b.total = round2(b.total + h.amount);
                if (h.lot.qualifies === 'yes') {
                    b.qualifying = round2(b.qualifying + h.amount);
                    report.qualifying = round2(report.qualifying + h.amount);
                } else if (h.lot.qualifies === 'no') {
                    b.notQualifying = round2(b.notQualifying + h.amount);
                    report.notQualifying = round2(report.notQualifying + h.amount);
                    note(excludedLines, h.lot.why === 'overnight'
                        ? 'Overnight camp — never claimable'
                        : h.lot.label, h.amount);
                } else {
                    b.needsReview = round2(b.needsReview + h.amount);
                    report.needsReview = round2(report.needsReview + h.amount);
                    note(reviewLines, h.lot.label, h.amount);
                }
            });
            // Whatever found no charge to land on is care not yet given.
            if (res.unapplied > 0.004) report.prepaid = round2(report.prepaid + res.unapplied);
        });

        report.paid.refunds = inYearRefunds;
        report.paid.net = round2(report.paid.gross - inYearRefunds);

        // Refunds come off proportionally to what the year's payments bought.
        if (inYearRefunds > 0.004 && report.paid.gross > 0.004) {
            var keep = Math.max(0, (report.paid.gross - inYearRefunds) / report.paid.gross);
            ['qualifying', 'notQualifying', 'needsReview', 'prepaid'].forEach(function (k) {
                report[k] = round2(report[k] * keep);
            });
            Object.keys(perCamper).forEach(function (k) {
                var b = perCamper[k];
                b.qualifying = round2(b.qualifying * keep);
                b.notQualifying = round2(b.notQualifying * keep);
                b.needsReview = round2(b.needsReview * keep);
                b.total = round2(b.total * keep);
            });
        }
        // Guarded separately from the proration above, which cannot run when
        // the year has no payments to prorate — and a year with refunds and no
        // payments is exactly the case that most needs saying out loud.
        if (inYearRefunds > report.paid.gross + 0.004) {
            report.warnings.push('Refunds in ' + year + ' exceed payments in ' + year + ' — the family was ' +
                'refunded money they paid in an earlier year. Nothing is claimable for ' + year + ', and the ' +
                'earlier year’s return may need amending.');
        }

        // A child's age is the parent's business, not the camp's — but a child
        // who turns 13 mid-summer is the one thing an office gets asked about
        // and the one thing this data can answer, so it is a note, not a rule.
        Object.keys(perCamper).forEach(function (k) {
            var c = campers[k];
            var dob = c && ymd(c.dob);
            if (!dob) return;
            var turns13 = String(Number(dob.slice(0, 4)) + 13) + dob.slice(4);
            if (turns13.slice(0, 4) <= year) {
                perCamper[k].notes.push(Number(turns13.slice(0, 4)) < Number(year)
                    ? 'Turned 13 before ' + year + ' — care for a child 13 or older does not qualify'
                    : 'Turns 13 on ' + turns13 + ' — only care before that date qualifies');
            }
        });

        report.byCamper = Object.keys(perCamper).sort().map(function (k) { return perCamper[k]; });
        report.review = Object.keys(reviewLines).map(function (k) { return reviewLines[k]; })
            .filter(function (r) { return Math.abs(r.amount) > 0.004; });
        report.excluded = Object.keys(excludedLines).map(function (k) { return excludedLines[k]; })
            .filter(function (r) { return Math.abs(r.amount) > 0.004; });

        if (report.prepaid > 0.004) {
            report.warnings.push('$' + report.prepaid.toFixed(2) + ' was paid in ' + year +
                ' toward camp that had not been billed yet. Under IRS Publication 503 that belongs on the ' +
                'return for the year the care is actually given, so it is not included above.');
        }
        if (report.needsReview > 0.004) {
            report.warnings.push('$' + report.needsReview.toFixed(2) + ' is on charges we could not classify. ' +
                'It is counted in neither total — decide whether each is care before sending this out.');
        }
        if (report.undated.count) {
            report.warnings.push(report.undated.count + ' payment' + (report.undated.count === 1 ? '' : 's') +
                ' totalling $' + Math.abs(report.undated.amount).toFixed(2) + ' carry no date and could not be ' +
                'placed in a year. Date them before relying on this statement.');
        }
        if (report.uncollected.count) {
            report.warnings.push(report.uncollected.count + ' payment' + (report.uncollected.count === 1 ? '' : 's') +
                ' totalling $' + Math.abs(report.uncollected.amount).toFixed(2) + ' are pending or failed and are ' +
                'not counted — a payment that never cleared is not an expense.');
        }
        if (!report.byCamper.length && report.paid.net > 0.004) {
            report.allocated = false;
            report.warnings.push('Payments in ' + year + ' could not be matched to any charge, so they cannot be ' +
                'split per child. Form 2441 is filled in one child at a time, so this has to be split by hand.');
        }
        var unassigned = perCamper['(unassigned)'];
        if (unassigned && unassigned.total > 0.004) {
            report.warnings.push('$' + unassigned.total.toFixed(2) + ' landed on charges with no camper on them ' +
                '(account-level fees). Form 2441 needs a child against every amount.');
        }
        return report;
    };

    /** The years this ledger has any money in, newest first. */
    T.yearsPresent = function (entries) {
        var seen = {};
        (entries || []).forEach(function (e) {
            if (!e || e.type !== 'payment') return;
            var y = ymd(e.date).slice(0, 4);
            if (y) seen[y] = 1;
        });
        return Object.keys(seen).sort().reverse().map(Number);
    };

    /** Is this statement safe to hand a family? */
    T.readiness = function (report, provider) {
        var missing = [];
        provider = provider || {};
        if (!provider.taxId) missing.push('the camp’s Tax ID / EIN — a parent cannot file Form 2441 without it');
        if (!provider.name) missing.push('the camp’s legal name');
        if (!provider.address) missing.push('the camp’s address');
        return { ready: !missing.length && !!report && report.allocated, missing: missing };
    };

    if (typeof root !== 'undefined' && root) root.CampistryTaxStatement = T;
    if (typeof module !== 'undefined' && module.exports) module.exports = T;
})(typeof window !== 'undefined' ? window : null);
