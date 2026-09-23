/* =============================================================================
 * campistry_closeout.js — what happens to the money left over when camp ends.
 *
 * THE PROBLEM. A season ends and two different pots are still holding money:
 *
 *   * a FAMILY credit balance — they overpaid, or a transfer to a cheaper session
 *     left them ahead, or a withdrawal credit outran what was owed;
 *   * a CAMPER's unspent canteen money — prepaid spending money nobody spent.
 *
 * Today neither has an ending. The balance sits on the books into next summer,
 * where it blocks re-enrolment and makes the aging report wrong, and the canteen
 * money just stays there until a parent notices and asks. There is a mechanism for
 * bulk canteen refunds and no POLICY for any of it.
 *
 * ── THE TWO POTS ARE DIFFERENT OBJECTS AND THIS FILE KEEPS THEM APART ──────
 *
 * Money in this app lives on two axes deliberately: tuition and the ledger belong
 * to the FAMILY, and canteen spending belongs to the CAMPER — a daily limit only
 * means anything per child. So a close-out has to be told about both, and a camp
 * may reasonably answer them differently: refund the family's overpayment to the
 * card it came from, and roll the child's $6 of canteen money into next season.
 *
 * ── WHAT THE CAMP CHOOSES ──────────────────────────────────────────────────
 *
 *   bill          leave it as credit against what they owe — the default, and the
 *                 only option that costs nobody anything
 *   refund_card   back to the card it came from
 *   cash          handed over at the office, recorded as a cash disbursement
 *   check         a cheque written and posted
 *   roll_forward  carried into next season as an opening credit
 *   donate        kept by the camp, with the family told
 *   hold          left exactly where it is, deliberately, to decide later
 *
 * ── THE CONSTRAINT THAT MAKES refund_card DIFFERENT FROM THE REST ──────────
 *
 * You cannot refund to a card more than that card actually paid, and not after the
 * processor's window has closed. So refund_card is the one choice this file may
 * have to REFUSE PART OF — $40 owed back with only $12 refundable leaves $28 that
 * needs a second answer. Rather than silently short-paying or silently falling
 * back, it returns both parts and names the fallback, so an office sees the whole
 * disposition before it agrees to any of it.
 *
 * It PLANS and writes nothing. The arithmetic is the part worth testing.
 * ========================================================================== */
(function (root) {
    'use strict';
    var C = {};

    function money(n) {
        var v = Math.round((Number(n) || 0) * 100) / 100;
        return Number.isFinite(v) ? v : 0;
    }
    function str(s) { return String(s == null ? '' : s).trim(); }

    /** Every disposition a camp may choose, and what each one means out loud. */
    C.OPTIONS = [
        { id: 'bill',         label: 'Leave as credit on their bill',
          blurb: 'Stays on the account and comes off whatever they owe next.' },
        { id: 'refund_card',  label: 'Refund to the card they paid with',
          blurb: 'Limited to what that card paid, and to the processor’s refund window.' },
        { id: 'cash',         label: 'Hand back in cash',
          blurb: 'Recorded as a cash disbursement at the office.' },
        { id: 'check',        label: 'Send a cheque',
          blurb: 'Recorded now, posted by the office.' },
        { id: 'roll_forward', label: 'Roll into next season',
          blurb: 'Carried over as an opening credit.' },
        { id: 'donate',       label: 'Donate to the camp',
          blurb: 'Kept by the camp. The family is told either way.' },
        { id: 'hold',         label: 'Leave it for now',
          blurb: 'Nothing happens. Decide later.' }
    ];

    /** Dispositions that move real money OUT of the camp. */
    C.PAYS_OUT = { refund_card: 1, cash: 1, check: 1 };

    C.isOption = function (id) {
        return C.OPTIONS.some(function (o) { return o.id === str(id); });
    };

    /**
     * A camp's close-out policy, with the defaults that cost nobody anything.
     *
     * `minToReturn` exists because posting a cheque for 40 cents costs more than the
     * 40 cents. Below it, the remainder follows `belowMinimum` instead — which
     * defaults to leaving it on the bill rather than to donating, because a camp
     * keeping small change by default is the kind of thing that reads badly however
     * it was meant.
     */
    C.normalize = function (p) {
        p = p || {};
        function opt(v, fallback) { return C.isOption(v) ? str(v) : fallback; }
        return {
            family:       opt(p.family, 'bill'),
            canteen:      opt(p.canteen, 'roll_forward'),
            minToReturn:  Math.max(0, money(p.minToReturn != null ? p.minToReturn : 1)),
            belowMinimum: opt(p.belowMinimum, 'bill'),
            notify:       p.notify !== false      // tell the family, unless told not to
        };
    };

    /**
     * Plan the close-out of ONE pot.
     *
     * o = { amount, disposition, refundableToCard, label, policy }
     *
     * Returns { ok, steps, warnings, note } where each step is
     * { do, amount, via, note }. `do` is the disposition actually applied, which is
     * not always the one asked for — see the refund_card constraint in the header.
     */
    C.planPot = function (o) {
        o = o || {};
        var pol = C.normalize(o.policy);
        var amount = money(o.amount);
        var label = str(o.label) || 'the balance';
        var want = C.isOption(o.disposition) ? str(o.disposition) : 'bill';
        var steps = [], warnings = [];

        if (amount <= 0) {
            return { ok: true, steps: [], warnings: [], note: '',
                     amount: 0, disposition: want };
        }

        // Too small to be worth paying out. The threshold applies only to money
        // LEAVING the camp — leaving 40 cents as credit costs nothing, so there is
        // no reason to divert it.
        if (C.PAYS_OUT[want] && amount < pol.minToReturn) {
            steps.push({ do: pol.belowMinimum, amount: amount, via: 'below_minimum',
                         note: label + ' is under the ' + pol.minToReturn.toFixed(2)
                             + ' minimum to pay out' });
            return { ok: true, steps: steps, warnings: [], amount: amount,
                     disposition: pol.belowMinimum, note: 'below_minimum' };
        }

        if (want !== 'refund_card') {
            steps.push({ do: want, amount: amount, via: 'chosen', note: label });
            return { ok: true, steps: steps, warnings: warnings, amount: amount,
                     disposition: want, note: '' };
        }

        // refund_card, the only one with a ceiling that is not the amount itself.
        var canCard = money(o.refundableToCard);
        if (canCard < 0) canCard = 0;
        if (canCard > amount) canCard = amount;

        if (canCard > 0) {
            steps.push({ do: 'refund_card', amount: canCard, via: 'chosen', note: label });
        }
        var rest = money(amount - canCard);
        if (rest > 0) {
            // NAMED, not silent. An office agreeing to "refund it" needs to see that
            // part of it cannot go back that way before it agrees.
            var fb = (rest < pol.minToReturn) ? pol.belowMinimum : pol.family;
            if (fb === 'refund_card') fb = 'bill';        // no infinite regress
            steps.push({ do: fb, amount: rest, via: 'card_limit',
                         note: label + ' — not refundable to a card' });
            warnings.push('Only ' + canCard.toFixed(2) + ' of ' + amount.toFixed(2)
                + ' can go back to a card' + (canCard === 0 ? '' : ' (the rest is either '
                + 'outside the refund window or was not paid by card)')
                + '. The remaining ' + rest.toFixed(2) + ' is set to: '
                + C.labelFor(fb) + '.');
        }
        return { ok: true, steps: steps, warnings: warnings, amount: amount,
                 disposition: 'refund_card', note: rest > 0 ? 'partial_card' : '' };
    };

    C.labelFor = function (id) {
        var o = C.OPTIONS.filter(function (x) { return x.id === str(id); })[0];
        return o ? o.label : str(id);
    };

    /**
     * Plan a whole family's close-out: their credit balance, plus every camper's
     * unspent canteen money.
     *
     * o = {
     *   familyCredit, refundableToCard,
     *   campers: [{ name, canteen, refundableToCard }],
     *   policy, familyDisposition, canteenDisposition
     * }
     *
     * The per-pot disposition can be overridden case by case — a camp sets a policy
     * and then a family asks for something else, which is the normal way this goes.
     */
    C.plan = function (o) {
        o = o || {};
        var pol = C.normalize(o.policy);
        var out = { ok: true, total: 0, steps: [], warnings: [], pots: [] };

        var fam = C.planPot({
            amount: o.familyCredit,
            disposition: o.familyDisposition || pol.family,
            refundableToCard: o.refundableToCard,
            label: 'Account credit', policy: pol
        });
        if (fam.amount > 0) {
            out.pots.push({ kind: 'family', name: '', plan: fam });
            out.steps = out.steps.concat(fam.steps.map(function (s) {
                return Object.assign({ kind: 'family' }, s);
            }));
            out.warnings = out.warnings.concat(fam.warnings);
            out.total = money(out.total + fam.amount);
        }

        (Array.isArray(o.campers) ? o.campers : []).forEach(function (c) {
            if (!c) return;
            var p = C.planPot({
                amount: c.canteen,
                disposition: c.disposition || o.canteenDisposition || pol.canteen,
                refundableToCard: c.refundableToCard,
                label: (str(c.name) || 'A camper') + '’s canteen money',
                policy: pol
            });
            if (p.amount <= 0) return;
            var cid = (c.camperId != null && c.camperId !== '') ? c.camperId : null;
            out.pots.push({ kind: 'canteen', name: str(c.name), camperId: cid, plan: p });
            out.steps = out.steps.concat(p.steps.map(function (s) {
                return Object.assign({ kind: 'canteen', camper: str(c.name), camperId: cid }, s);
            }));
            out.warnings = out.warnings.concat(p.warnings);
            out.total = money(out.total + p.amount);
        });

        // What the camp is actually paying out, which is the number a bookkeeper
        // wants before approving a batch.
        out.paidOut = money(out.steps.reduce(function (n, s) {
            return C.PAYS_OUT[s.do] ? n + money(s.amount) : n;
        }, 0));
        out.kept = money(out.steps.reduce(function (n, s) {
            return s.do === 'donate' ? n + money(s.amount) : n;
        }, 0));
        out.notify = pol.notify;
        return out;
    };

    /** A one-line summary for a confirmation. Empty when there is nothing to do. */
    C.describe = function (p) {
        if (!p || !p.total) return '';
        var bits = [p.total.toFixed(2) + ' in all'];
        if (p.paidOut > 0) bits.push(p.paidOut.toFixed(2) + ' paid back');
        if (p.kept > 0) bits.push(p.kept.toFixed(2) + ' donated');
        var rest = money(p.total - p.paidOut - p.kept);
        if (rest > 0) bits.push(rest.toFixed(2) + ' left on account or carried over');
        return bits.join(' · ');
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = C;
    if (root) root.CampistryCloseout = C;
})(typeof window !== 'undefined' ? window : null);
