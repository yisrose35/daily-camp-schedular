// =============================================================================
// campistry_billing_core.js — the family billing account: an immutable ledger
//
// Pure functions. No DOM, no storage, no implicit clock — every date-sensitive
// call takes the date it should reason about.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS: A BALANCE THAT COULD DISAPPEAR
//
// Campistry used to work out what a family owed by RE-DERIVING it on every
// render: loop the enrollments, add up tuition for the ones currently marked
// 'enrolled' or 'accepted', subtract the payments. The number was never stored;
// it was recomputed from live state each time.
//
// That makes a debt a CALCULATION rather than a FACT, and a calculation stops
// being true the moment one of its inputs goes away. Take the camper out of camp
// — withdraw them, or delete them, or reset the roster for a new summer — and
// the enrollment that justified the charge is gone, so the charge is gone, so
// the debt is gone. The camp is still owed the money. Nothing in the system says
// so any more. (TEST_FINDINGS.md D0 and the delete case.)
//
// Every serious billing system solves this the same way, because it is ordinary
// double-entry accounting: a posted charge is a FACT and facts are immutable.
// You do not delete or edit a posted charge. If something changes, you POST
// ANOTHER ENTRY — a credit, a correction, a reversal — and the balance moves
// because the ledger got longer, never because history got edited. Blackbaud,
// FACTS and every general ledger behind them work this way. FACTS draws the same
// distinction this module does between a CORRECTION (the charge was wrong,
// reduce what was assessed) and a CREDIT (the charge was right, we are
// forgiving or refunding part of it) — the two mean different things in a
// revenue report even when they move the balance by the same amount.
//
// So:
//
//     balance = Σ charges + Σ refunds − Σ credits − Σ payments
//
// over an append-only list. There is no stored balance to drift, no field to
// clamp, and no input whose disappearance can erase a debt. A withdrawal posts
// a credit; the original tuition charge stays on the record for ever, which is
// also what lets an office answer "why does this family owe $1,500?" a year
// later.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULES, ALL FOUR
//
//   1. ENTRIES ARE NEVER MUTATED AND NEVER REMOVED. Nothing in this file writes
//      to an existing entry. `reverse()` appends the opposite entry; it does not
//      set a flag on the original. Even the back-pointer ("what reversed this?")
//      is DERIVED by scanning, so that an entry, once posted, is genuinely
//      read-only for the rest of its life.
//
//   2. POSTING IS IDEMPOTENT WHERE IT HAS TO BE. Moving from derived to posted
//      introduces one new way to lose money in the opposite direction: post the
//      same tuition twice and the family is double-billed. Every posting helper
//      that represents a real-world event exactly once (`postTuition` for an
//      enrollment, `creditWithdrawal` for a withdrawal) is keyed on that event
//      and refuses to post a second time. Callers may therefore run on every
//      render without thinking about it.
//
//   3. AMOUNTS ARE ALWAYS POSITIVE. The sign lives in `kind`. A negative amount
//      is rejected rather than quietly flipped, because "a payment of −50" is
//      ambiguous — it could mean a refund or a typo, and guessing is how a
//      ledger stops being trusted.
//
//   4. THE ACCOUNT OUTLIVES THE ENROLLMENT. An account belongs to a FAMILY, and
//      is linked to campers by stable `camperId`, never by name. Names are
//      display labels: two children called the same thing across two summers is
//      ordinary, and joining money to a string is how one inherits the other's
//      balance (D4).
//
// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT PLANS: THE AMOUNT IS DERIVED, NEVER FROZEN
//
// The old plan model stored a frozen array of dated instalments each with a
// mutable `status`, then reconciled that array against the recomputed balance
// and wrote `status:'paid'` on instalments it had decided not to charge. That
// conflates "nothing is owed at this instant" with "this instalment is settled
// for ever", so a temporary zero balance destroyed an instalment permanently and
// nothing ever reopened it (D1: a family parked for three months of a six-month
// plan came back $1,500 short with a plan that read fully paid).
//
// Here a plan stores WHEN, never HOW MUCH:
//
//     { id, autopay, dueDates:[…], count, nextIndex, history:[…] }
//
// and the amount is worked out at charge time as
//
//     outstanding / instalments remaining
//
// with the last one sweeping the remainder so rounding cannot leave cents
// behind. This is how CampMinder's instalment billing behaves — invoicing takes
// a proportion of the balance DUE and advances an instalment counter — and it
// makes every awkward case ordinary: a parent who overpays early just gets
// smaller instalments, a late discount self-corrects, a parked camper is charged
// nothing without anything being destroyed, and a re-enrolled one is charged
// again because the balance says so.
//
// `history` is append-only and records what ACTUALLY happened, including
// `charged: 0` with a reason. Nothing is ever recorded as paid that was not
// charged, so a plan can no longer present as settled while money is owed.
// =============================================================================

(function () {
    'use strict';

    var B = {};

    // ── money ──────────────────────────────────────────────────────────────
    // Two decimal places, half-up, applied at every boundary. Everything here
    // is dollars; the processors take cents and convert at their own edge.
    function money(n) {
        var v = Number(n);
        if (!isFinite(v)) return 0;
        return Math.round(v * 100) / 100;
    }
    B.money = money;

    /** Entry kinds and which way each moves the balance. */
    var SIGN = { charge: 1, refund: 1, credit: -1, payment: -1 };
    B.KINDS = Object.keys(SIGN);

    // Why a charge or a credit exists. Kept as a closed list because the
    // revenue report groups by it — an unrecognised reason would silently fall
    // out of "assessed" and "discounted" and make the two stop adding up.
    B.REASONS = [
        'tuition', 'fee', 'canteen', 'shop', 'luggage', 'other',   // charges
        'discount', 'withdrawal', 'goodwill', 'correction',         // credits
        'scholarship', 'sibling',                                   // credits
        'card', 'cash', 'check', 'zelle', 'ach', 'autopay',         // payments
        'chargeback', 'refund',                                     // refunds
        'reversal', 'adjustment',                                   // either
    ];
    // The three `refund`-kind reasons are deliberately distinct, because a camp
    // reading a statement needs to tell them apart:
    //   refund     — the camp chose to give money back.
    //   chargeback — the parent's bank pulled it back.
    //   reversal   — it never really arrived (an ACH debit returned after it
    //                had already settled, so a payment entry has to be undone).
    // All three raise the balance by the same amount; only one of them is a
    // decision anybody made.

    // A credit whose reason is one of these reduces what was ASSESSED (the
    // charge should not have been that big). Everything else reduces what is
    // OWED while leaving the assessment standing. FACTS draws the same line and
    // it matters: the first shrinks your revenue, the second is a discount you
    // gave, and a camp reporting to a board needs them apart.
    var CORRECTION_REASONS = { correction: 1, reversal: 1, adjustment: 1 };

    // A chargeback is NOT a refund the camp chose to give — it is cash pulled
    // back by the parent's bank. It posts as a `refund` entry because the effect
    // on the balance is identical (they owe it again), but the reason keeps the
    // two apart in a report: one is a decision, the other is a loss.

    var _seq = 0;
    function newId(prefix, now) {
        _seq = (_seq + 1) % 100000;
        var t = (now instanceof Date ? now : new Date()).getTime();
        return (prefix || 'le') + '_' + t.toString(36) + '_' + _seq.toString(36);
    }
    B.newId = newId;

    // ── the account ────────────────────────────────────────────────────────

    /**
     * A fresh billing account for a family. `camperIds` are STABLE IDS, not
     * names — see rule 4.
     */
    B.newAccount = function (o) {
        o = o || {};
        return {
            famKey: o.famKey || '',
            name: o.name || '',
            camperIds: Array.isArray(o.camperIds) ? o.camperIds.slice() : [],
            entries: [],
            plans: [],
            openedAt: o.openedAt || new Date().toISOString(),
        };
    };

    function entriesOf(account) {
        return (account && Array.isArray(account.entries)) ? account.entries : [];
    }
    B.entriesOf = entriesOf;

    // ── posting ────────────────────────────────────────────────────────────

    /**
     * Append one entry. The ONLY way anything enters a ledger.
     *
     * Returns { ok, entry } or { ok:false, error }. Never throws on bad input,
     * because every caller is a UI or a webhook that has to do something
     * sensible with a rejection rather than crash mid-payment.
     */
    B.post = function (account, e, now) {
        if (!account || typeof account !== 'object') return { ok: false, error: 'no_account' };
        if (!Array.isArray(account.entries)) account.entries = [];
        e = e || {};

        if (!SIGN[e.kind]) return { ok: false, error: 'bad_kind' };
        var amt = money(e.amount);
        // Rule 3: the sign lives in `kind`. A negative amount is a caller bug,
        // not something to reinterpret.
        if (!(amt > 0)) return { ok: false, error: 'bad_amount' };
        if (e.reason && B.REASONS.indexOf(e.reason) < 0) return { ok: false, error: 'bad_reason' };

        var stamp = (now instanceof Date ? now : new Date());
        var entry = {
            id: e.id || newId('le', stamp),
            kind: e.kind,
            amount: amt,
            reason: e.reason || 'other',
            date: e.date || stamp.toISOString().slice(0, 10),
            postedAt: stamp.toISOString(),
            note: e.note || '',
            by: e.by || 'system',
            source: e.source && typeof e.source === 'object' ? e.source : {},
        };
        if (e.reverses) entry.reverses = String(e.reverses);

        account.entries.push(entry);
        return { ok: true, entry: entry };
    };

    /** Find an entry by id. */
    B.find = function (account, id) {
        var all = entriesOf(account);
        for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
        return null;
    };

    /**
     * What reversed this entry, if anything — DERIVED, never stored on the
     * original (rule 1). Scanning is cheap next to the cost of a mutable
     * `reversedBy` field that a half-finished write could leave lying.
     */
    B.reversalOf = function (account, id) {
        var all = entriesOf(account);
        for (var i = 0; i < all.length; i++) if (all[i].reverses === id) return all[i];
        return null;
    };

    B.isReversed = function (account, id) { return !!B.reversalOf(account, id); };

    /**
     * Undo an entry the honest way: post its mirror image. The original stays
     * exactly as it was, so "this was charged in March and reversed in April"
     * remains answerable for ever.
     *
     * Reversing twice is refused — two mirrors of one charge would credit the
     * family twice.
     */
    B.reverse = function (account, id, o, now) {
        o = o || {};
        var orig = B.find(account, id);
        if (!orig) return { ok: false, error: 'not_found' };
        if (B.isReversed(account, id)) return { ok: false, error: 'already_reversed' };
        if (orig.reverses) return { ok: false, error: 'cannot_reverse_a_reversal' };

        var mirror = { charge: 'credit', credit: 'charge', payment: 'refund', refund: 'payment' };
        return B.post(account, {
            kind: mirror[orig.kind],
            amount: orig.amount,
            reason: 'reversal',
            date: o.date || undefined,
            note: o.note || ('Reverses ' + (orig.reason || orig.kind) + ' of ' + orig.amount.toFixed(2)),
            by: o.by || 'office',
            reverses: orig.id,
            source: orig.source || {},
        }, now);
    };

    // ── reading ────────────────────────────────────────────────────────────

    /**
     * What the family owes. Positive = they owe the camp. Negative = the camp
     * owes them, and is deliberately NOT clamped to zero: clamping hides a
     * refund the camp genuinely owes, which is the same class of bug as a
     * disappearing debt, just pointing the other way.
     */
    B.balance = function (account) {
        var all = entriesOf(account), t = 0;
        for (var i = 0; i < all.length; i++) {
            var e = all[i], s = SIGN[e.kind];
            if (s) t += s * money(e.amount);
        }
        return money(t);
    };

    /** The numbers an office and a board each need, kept apart on purpose. */
    B.summary = function (account) {
        var all = entriesOf(account);
        var assessed = 0, corrections = 0, discounts = 0, paid = 0, refunded = 0;
        for (var i = 0; i < all.length; i++) {
            var e = all[i], amt = money(e.amount);
            if (e.kind === 'charge') assessed += amt;
            else if (e.kind === 'payment') paid += amt;
            else if (e.kind === 'refund') refunded += amt;
            else if (e.kind === 'credit') {
                if (CORRECTION_REASONS[e.reason]) corrections += amt;
                else discounts += amt;
            }
        }
        return {
            assessed: money(assessed),           // gross charged
            corrections: money(corrections),     // charged in error — reduces assessment
            discounts: money(discounts),         // deliberately given back
            netAssessed: money(assessed - corrections),
            collected: money(paid - refunded),   // money actually kept
            paid: money(paid),
            refunded: money(refunded),
            balance: money(assessed + refunded - discounts - corrections - paid),
            entryCount: all.length,
        };
    };

    /**
     * Does this account carry money? The predicate that decides whether a
     * family record may be deleted when its last camper leaves.
     *
     * A ledger with any entry at all counts, even one netting to zero: a family
     * that paid $3,000 and was credited $3,000 is a closed account with a
     * history worth keeping, not an empty one. Only a genuinely untouched
     * account — no entries, no plan, no card — is safe to drop.
     */
    B.hasMoney = function (account) {
        if (!account) return false;
        if (entriesOf(account).length > 0) return true;
        if (Array.isArray(account.plans) && account.plans.length > 0) return true;
        if (account.cardOnFile || account.byopCustomerRef || account.stripeCustomerId) return true;
        var m = account.savedPaymentMethods;
        return !!(Array.isArray(m) && m.length);
    };

    // ── tuition, and taking a camper out ───────────────────────────────────

    /**
     * Post tuition for an enrollment, at most once, ever.
     *
     * Idempotent on (enrollmentId, reason 'tuition') and NOT on the amount —
     * deliberately. If the session price later changes, that is a correction to
     * post, not a reason to bill the family a second time. Rule 2 exists
     * because this is the one call a render loop might make repeatedly.
     */
    B.postTuition = function (account, enr, now) {
        enr = enr || {};
        var eid = enr.enrollmentId || enr.id;
        if (!eid) return { ok: false, error: 'no_enrollment_id' };

        var existing = B.tuitionEntryFor(account, eid);
        if (existing) return { ok: true, entry: existing, alreadyPosted: true };

        var gross = money(enr.tuition);
        if (!(gross > 0)) return { ok: false, error: 'bad_amount' };

        var res = B.post(account, {
            kind: 'charge', amount: gross, reason: 'tuition',
            date: enr.date, by: enr.by || 'system',
            // The name as people read it: without the roster's internal
            // " #<number>" that tells two same-named campers apart.
            note: enr.note || ('Tuition — ' + String(enr.camperName || '').replace(/\s#\d+(?:-\d+)?$/, '') +
                  (enr.session ? ', ' + enr.session : '')).trim(),
            source: {
                enrollmentId: eid, camperId: enr.camperId != null ? enr.camperId : null,
                camperName: enr.camperName || '', session: enr.session || '',
                season: enr.season || '',
            },
        }, now);
        if (!res.ok) return res;

        // A discount is a CREDIT against the gross charge, not a smaller charge.
        // Keeping them as two entries is what lets a camp report what it billed
        // and what it gave away, instead of only the difference.
        var disc = money(enr.discount);
        if (disc > 0) {
            if (disc > gross) disc = gross;      // never discount past free
            B.post(account, {
                kind: 'credit', amount: disc, reason: enr.discountReason || 'discount',
                date: enr.date, by: enr.by || 'system',
                note: enr.discountNote || 'Discount',
                source: { enrollmentId: eid, camperId: enr.camperId != null ? enr.camperId : null },
            }, now);
        }
        return res;
    };

    B.tuitionEntryFor = function (account, enrollmentId) {
        var all = entriesOf(account);
        for (var i = 0; i < all.length; i++) {
            var e = all[i];
            if (e.kind === 'charge' && e.reason === 'tuition' &&
                e.source && e.source.enrollmentId === enrollmentId) return e;
        }
        return null;
    };

    /** Net tuition still standing for an enrollment: charge − its credits. */
    B.netTuitionFor = function (account, enrollmentId) {
        var all = entriesOf(account), t = 0;
        for (var i = 0; i < all.length; i++) {
            var e = all[i];
            if (!e.source || e.source.enrollmentId !== enrollmentId) continue;
            if (e.kind === 'charge') t += money(e.amount);
            else if (e.kind === 'credit') t -= money(e.amount);
        }
        return money(t);
    };

    /**
     * A camper leaves. This is the whole point of the module, so it is worth
     * being explicit about what it does NOT do: it does not touch the tuition
     * charge. The charge happened. What changes is that some or all of it is no
     * longer owed, which is a CREDIT.
     *
     * `policy` says how much to forgive:
     *   'none'                   keep the whole balance owed (default)
     *   'full'                   forgive all of it
     *   {percent: 50}            forgive half of the net tuition
     *   {amount: 250}            forgive a fixed amount
     *   {keepDeposit: 500}       forgive everything except a non-refundable 500
     *
     * Idempotent per enrollment: a second withdrawal credits nothing.
     */
    B.creditWithdrawal = function (account, o, now) {
        o = o || {};
        var eid = o.enrollmentId;
        if (!eid) return { ok: false, error: 'no_enrollment_id' };
        if (B.withdrawalCreditFor(account, eid)) {
            return { ok: true, alreadyCredited: true, entry: B.withdrawalCreditFor(account, eid) };
        }
        if (!B.tuitionEntryFor(account, eid)) return { ok: false, error: 'no_tuition_posted' };

        var net = B.netTuitionFor(account, eid);
        if (net <= 0) return { ok: true, nothingToCredit: true };

        var p = o.policy == null ? 'none' : o.policy;
        var amount = 0;
        if (p === 'full') amount = net;
        else if (p === 'none') amount = 0;
        else if (typeof p === 'object') {
            if (p.percent != null) amount = money(net * (Number(p.percent) || 0) / 100);
            else if (p.amount != null) amount = money(p.amount);
            else if (p.keepDeposit != null) amount = money(net - money(p.keepDeposit));
        }
        if (amount <= 0) return { ok: true, nothingToCredit: true, kept: net };
        if (amount > net) amount = net;

        return B.post(account, {
            kind: 'credit', amount: amount, reason: 'withdrawal',
            date: o.date, by: o.by || 'office',
            note: o.note || ('Withdrawn — ' + (String(o.camperName || '').replace(/\s#\d+(?:-\d+)?$/, '') || 'camper') +
                             (amount < net ? ' (partial)' : '')),
            source: {
                enrollmentId: eid,
                camperId: o.camperId != null ? o.camperId : null,
                camperName: o.camperName || '',
                reason: 'withdrawal',
            },
        }, now);
    };

    B.withdrawalCreditFor = function (account, enrollmentId) {
        var all = entriesOf(account);
        for (var i = 0; i < all.length; i++) {
            var e = all[i];
            if (e.kind === 'credit' && e.reason === 'withdrawal' &&
                e.source && e.source.enrollmentId === enrollmentId) return e;
        }
        return null;
    };

    // ── payment plans: WHEN, never HOW MUCH ────────────────────────────────

    B.newPlan = function (o) {
        o = o || {};
        var dates = Array.isArray(o.dueDates) ? o.dueDates.slice().sort() : [];
        return {
            id: o.id || newId('plan'),
            autopay: o.autopay !== false,
            paused: !!o.paused,
            dueDates: dates,
            count: dates.length,
            nextIndex: 0,
            history: [],
        };
    };

    /**
     * What is due on this plan as of `asOf`, or null if nothing is.
     *
     * The amount is `outstanding / instalments remaining`, so it tracks reality
     * instead of a number frozen months ago. The final instalment sweeps the
     * whole remainder, which is what stops rounding leaving a few cents
     * uncollectable at the end of every plan.
     */
    B.planDue = function (account, plan, asOf) {
        if (!plan || plan.paused) return null;
        var dates = Array.isArray(plan.dueDates) ? plan.dueDates : [];
        var i = Number(plan.nextIndex) || 0;
        if (i >= dates.length) return null;
        var due = dates[i];
        if (!due || (asOf && due > asOf)) return null;       // not due yet

        var outstanding = B.balance(account);
        if (outstanding <= 0.005) {
            return { index: i, dueDate: due, amount: 0, remaining: dates.length - i,
                     reason: 'nothing_owed' };
        }
        var remaining = dates.length - i;
        // The amount the office set for this instalment, when it set one
        // (TED-068, migration 264's plan_due) — never more than is owed.
        var fixed = Array.isArray(plan.amounts) && typeof plan.amounts[i] === 'number' ? plan.amounts[i] : null;
        var amount = (fixed != null && fixed > 0) ? Math.min(money(fixed), outstanding)
                   : (remaining <= 1) ? outstanding : money(outstanding / remaining);
        if (amount > outstanding) amount = outstanding;
        return { index: i, dueDate: due, amount: amount, remaining: remaining };
    };

    /**
     * Record what happened to one instalment and advance the counter.
     *
     * `charged: 0` is a legitimate outcome and is recorded as such WITH its
     * reason. Nothing here can mark an instalment paid — there is no such field
     * — which is the structural reason D1 cannot recur.
     */
    B.recordInstalment = function (plan, o, now) {
        if (!plan) return { ok: false, error: 'no_plan' };
        if (!Array.isArray(plan.history)) plan.history = [];
        o = o || {};
        var idx = (o.index != null) ? Number(o.index) : Number(plan.nextIndex) || 0;

        for (var i = 0; i < plan.history.length; i++) {
            if (plan.history[i].index === idx) {
                return { ok: true, alreadyRecorded: true, row: plan.history[i] };
            }
        }
        var row = {
            index: idx,
            dueDate: o.dueDate || (plan.dueDates || [])[idx] || '',
            charged: money(o.charged),
            at: (now instanceof Date ? now : new Date()).toISOString(),
        };
        if (o.reason) row.reason = o.reason;
        if (o.paymentId) row.paymentId = o.paymentId;
        if (o.entryId) row.entryId = o.entryId;
        if (o.error) row.error = String(o.error);
        plan.history.push(row);
        if (idx >= (Number(plan.nextIndex) || 0)) plan.nextIndex = idx + 1;
        return { ok: true, row: row };
    };

    /**
     * Has this plan finished, and did it leave money behind?
     *
     * The second half is the point. The old model could conclude a plan with an
     * outstanding balance and present it as fully paid; here a plan that runs
     * out of dates with money owed reports `outstanding`, loudly, so it lands in
     * front of an office instead of nowhere.
     */
    B.planStatus = function (account, plan) {
        var dates = (plan && Array.isArray(plan.dueDates)) ? plan.dueDates : [];
        var done = (Number(plan && plan.nextIndex) || 0) >= dates.length;
        var bal = B.balance(account);
        var charged = 0;
        ((plan && plan.history) || []).forEach(function (h) { charged += money(h.charged); });
        return {
            complete: done,
            charged: money(charged),
            balance: bal,
            outstanding: done && bal > 0.005 ? bal : 0,
            settled: done && bal <= 0.005,
        };
    };

    /**
     * Every dollar a plan's history claims to have charged must be matched by a
     * real payment entry on the ledger. This is the invariant that replaces
     * "trust the status field", and it is cheap enough to assert in anger.
     */
    B.planReconciles = function (account, plan) {
        var claimed = 0;
        ((plan && plan.history) || []).forEach(function (h) { claimed += money(h.charged); });
        var posted = 0;
        entriesOf(account).forEach(function (e) {
            if (e.kind === 'payment' && e.source && e.source.planId === (plan && plan.id)) {
                posted += money(e.amount);
            }
        });
        return { claimed: money(claimed), posted: money(posted),
                 ok: money(claimed) === money(posted) };
    };

    if (typeof window !== 'undefined') window.BillingCore = B;
    if (typeof module !== 'undefined' && module.exports) module.exports = B;
})();
