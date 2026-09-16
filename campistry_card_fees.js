/* =============================================================================
 * campistry_card_fees.js — passing card costs to the parent, without breaking
 * the card brands' rules or a state's law.
 *
 * WHY THIS EXISTS. Camps ask for it constantly: a family who pays by card pays
 * the processing cost, a family who sends a cheque does not. That is a normal
 * thing to want and three different things to build, and they are not
 * interchangeable — the rules that govern them differ in ways that decide
 * whether a camp's merchant account survives the summer.
 *
 *   SURCHARGE. A percentage added for paying by CREDIT CARD. Capped at the
 *     lesser of the camp's own cost of acceptance and 3% (Visa's cap; Mastercard
 *     allows 4%, so a camp taking both is held to 3%). It may NEVER be applied
 *     to a debit card — PIN or signature — nor to prepaid, FSA, HSA or Medicare
 *     Flex cards. It is banned outright in Connecticut, Massachusetts, Maine and
 *     Puerto Rico, and Louisiana joins them on 1 August 2026. It must be
 *     disclosed before the parent commits to paying by card, it must appear as
 *     its own line on the receipt, and it must be REFUNDED proportionally
 *     whenever the payment behind it is refunded.
 *
 *   CONVENIENCE FEE. A FLAT amount for using a particular channel — paying
 *     online rather than by post. Not limited to credit cards, so it may apply
 *     to a debit card or an ACH transfer as well. Visa and American Express
 *     require it to be a fixed amount and not a percentage, which is the single
 *     most common way camps get this wrong: they set "2.9%" and call it a
 *     convenience fee, which is a surcharge wearing the wrong name and inherits
 *     none of a surcharge's protections.
 *
 *   CASH DISCOUNT. The card price is the posted price, and a family paying by
 *     cheque or bank transfer is given a discount. Legal everywhere, no cap, no
 *     card-type rules, no notice to the processor. It is the same money and the
 *     safest of the three, which is why it is worth offering as a first-class
 *     option rather than a footnote.
 *
 * THE GUARD THAT MATTERS MOST. A surcharge on a debit card is a card-brand
 * violation, and until this change Campistry had no way to tell a debit card
 * from a credit one: every card-saving path recorded the BRAND and the last four
 * digits and threw the FUNDING TYPE away. So this module refuses to surcharge
 * whenever the funding type is not known to be 'credit' — not as a default to be
 * overridden, but as the answer. A camp that cannot see funding types cannot
 * surcharge; it can use a flat convenience fee or a cash discount, both of which
 * are indifferent to card type.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not decide whether a camp may
 * surcharge in its state — it states what the card brands and the known state
 * bans require, and a camp's own processor agreement is the last word. It never
 * posts anything: the fee it returns is posted by the caller as its OWN ledger
 * charge, never folded into tuition, so that a refund can find it and a
 * year-end tax statement does not report a cost of paying as a cost of care.
 * ========================================================================== */
(function (root) {
    'use strict';
    var F = {};

    function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
    function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

    /** The card brands' ceiling, whatever a camp types in the box. */
    F.MAX_SURCHARGE_PCT = 3;

    /**
     * Where a credit-card surcharge is not allowed at all.
     *
     * Dated entries are laws with a start date, so a camp is not stopped early
     * and is not missed late. Keys are the two-letter codes the address fields
     * on this app's own forms already use.
     *
     * This list is the floor, not the whole truth: some state statutes have been
     * challenged in court, several states require the total price to be
     * disclosed rather than banning the fee, and a camp's processor agreement
     * can forbid surcharging whatever the state permits. `explain()` says so.
     */
    F.SURCHARGE_BANNED = {
        CT: { from: null, note: 'Connecticut prohibits credit-card surcharges' },
        MA: { from: null, note: 'Massachusetts prohibits credit-card surcharges' },
        ME: { from: null, note: 'Maine prohibits credit-card surcharges' },
        PR: { from: null, note: 'Puerto Rico prohibits credit-card surcharges' },
        LA: { from: '2026-08-01', note: 'Louisiana prohibits credit-card surcharges from 1 August 2026' }
    };

    /** Funding types that may be surcharged. Exactly one. */
    F.SURCHARGEABLE_FUNDING = { credit: 1 };

    F.MODES = ['off', 'surcharge', 'convenience', 'cash_discount'];

    /**
     * A policy that is always safe to read.
     *
     * An unset policy is `mode:'off'` — no fee. That is the only safe default:
     * a fee nobody configured, charged to a parent who was never told, is both a
     * card-brand violation and a chargeback.
     */
    F.normalize = function (raw) {
        var p = (raw && typeof raw === 'object') ? raw : {};
        var mode = F.MODES.indexOf(p.mode) >= 0 ? p.mode : 'off';
        return {
            mode: mode,
            // Surcharge: a percentage, held to the brands' cap here rather than
            // in the UI, so a policy saved by an older build or edited in the
            // cloud cannot exceed it either.
            surchargePct: Math.max(0, Math.min(F.MAX_SURCHARGE_PCT, num(p.surchargePct))),
            // The camp's real cost of acceptance, if it knows it. The brands cap
            // the surcharge at the LESSER of this and 3%, so a camp paying 2.6%
            // may not charge 3%.
            costOfAcceptancePct: Math.max(0, num(p.costOfAcceptancePct)),
            // Convenience: a FLAT amount. A percentage here is not a
            // convenience fee, so there is nowhere to put one.
            convenienceFlat: Math.max(0, round2(num(p.convenienceFlat))),
            // Cash discount: what a family paying by cheque/bank transfer saves.
            cashDiscountPct: Math.max(0, Math.min(100, num(p.cashDiscountPct))),
            cashDiscountFlat: Math.max(0, round2(num(p.cashDiscountFlat))),
            // Which channels a convenience fee applies to. An office taking a
            // cheque at the door is not a "convenient channel".
            onlineOnly: p.onlineOnly !== false,
            // The camp's own state, for the ban list. Absent means unknown, and
            // unknown does NOT mean permitted — see quote().
            state: String(p.state || '').trim().toUpperCase().slice(0, 2),
            // A camp must give its processor 30 days' written notice before
            // surcharging. Recording the date it did is the only way the app can
            // tell "configured" from "allowed to be switched on".
            processorNotifiedOn: String(p.processorNotifiedOn || '').slice(0, 10)
        };
    };

    /** Is a surcharge banned where this camp is, on this date? */
    F.stateBan = function (policy, onDate) {
        var p = F.normalize(policy);
        var ban = F.SURCHARGE_BANNED[p.state];
        if (!ban) return null;
        var day = String(onDate || '').slice(0, 10);
        if (ban.from && day && day < ban.from) return null;   // not yet in force
        return ban;
    };

    /** The surcharge percentage actually permitted: the lesser of everything. */
    F.effectivePct = function (policy) {
        var p = F.normalize(policy);
        var caps = [F.MAX_SURCHARGE_PCT, p.surchargePct];
        if (p.costOfAcceptancePct > 0) caps.push(p.costOfAcceptancePct);
        return Math.max(0, Math.min.apply(null, caps));
    };

    /**
     * What this payment's fee is.
     *
     * o = {
     *   amount,            // what the family is paying, before any fee
     *   method,            // 'card' | 'ach' | 'cash' | 'check' | 'other'
     *   funding,           // 'credit' | 'debit' | 'prepaid' | 'unknown' | ''
     *   channel,           // 'online' | 'office'
     *   onDate             // decides a dated state ban; defaults to today
     * }
     *
     * Returns { fee, discount, mode, reason, label, permitted }.
     *
     * `reason` always says WHY, including why not, because a camp that has
     * switched surcharging on and is collecting nothing needs to be told it is
     * because nobody can see whether the cards are debit.
     */
    F.quote = function (policy, o) {
        o = o || {};
        var p = F.normalize(policy);
        var amount = Math.max(0, round2(num(o.amount)));
        var method = String(o.method || '').toLowerCase() || 'card';
        var funding = String(o.funding || '').toLowerCase();
        var channel = String(o.channel || 'online').toLowerCase();
        var onDate = o.onDate || new Date().toISOString().slice(0, 10);

        var out = { fee: 0, discount: 0, mode: p.mode, reason: 'off',
                    label: '', permitted: true };
        if (p.mode === 'off' || amount <= 0) {
            out.reason = amount <= 0 ? 'nothing_to_charge' : 'off';
            return out;
        }

        if (p.mode === 'cash_discount') {
            // The card price is the price. A family paying any other way is
            // given a discount, which is legal everywhere and needs no notice.
            if (method === 'card') { out.reason = 'card_pays_posted_price'; return out; }
            var d = round2(amount * p.cashDiscountPct / 100) + p.cashDiscountFlat;
            out.discount = Math.min(amount, round2(d));
            out.reason = out.discount > 0 ? 'cash_discount' : 'no_discount_set';
            out.label = out.discount > 0
                ? 'Discount for not paying by card'
                : '';
            return out;
        }

        if (p.mode === 'convenience') {
            // A flat fee for the channel. Not a card rule, so debit and ACH pay
            // it too — but only where the channel applies.
            if (p.onlineOnly && channel !== 'online') { out.reason = 'not_online'; return out; }
            if (method === 'cash' || method === 'check') { out.reason = 'not_an_electronic_payment'; return out; }
            out.fee = Math.min(p.convenienceFlat, amount);   // never exceed the payment
            out.reason = out.fee > 0 ? 'convenience' : 'no_fee_set';
            out.label = out.fee > 0 ? 'Online payment fee' : '';
            return out;
        }

        // ── surcharge ────────────────────────────────────────────────────────
        if (method !== 'card') { out.reason = 'not_a_card'; return out; }

        var ban = F.stateBan(p, onDate);
        if (ban) {
            out.permitted = false;
            out.reason = 'banned_in_state';
            out.label = ban.note;
            return out;
        }
        if (!p.state) {
            // Not knowing where the camp is is not permission. Four states and
            // a territory ban this outright; charging blind is how a camp finds
            // out from a regulator.
            out.permitted = false;
            out.reason = 'state_unknown';
            out.label = 'Set the camp’s state before surcharging — it is banned in some';
            return out;
        }
        if (!p.processorNotifiedOn) {
            // Visa requires 30 days' written notice to the acquirer before a
            // merchant starts surcharging. A camp that has not given it is not
            // yet allowed to, whatever this app's settings say.
            out.permitted = false;
            out.reason = 'processor_not_notified';
            out.label = 'Tell your processor in writing first — 30 days’ notice is required';
            return out;
        }
        if (!F.SURCHARGEABLE_FUNDING[funding]) {
            // THE guard. Debit, prepaid, FSA, HSA and Medicare Flex may never be
            // surcharged, and an unknown funding type is treated as one of them
            // rather than guessed at: a surcharge on a debit card is a
            // violation, and a surcharge we failed to collect is a rounding
            // error.
            out.reason = funding && funding !== 'unknown' ? 'not_credit' : 'funding_unknown';
            out.label = out.reason === 'funding_unknown'
                ? 'Card type unknown — no surcharge applied'
                : 'Debit and prepaid cards are never surcharged';
            return out;
        }

        var pct = F.effectivePct(p);
        out.fee = round2(amount * pct / 100);
        out.reason = out.fee > 0 ? 'surcharge' : 'no_fee_set';
        out.label = out.fee > 0 ? pct + '% credit-card surcharge' : '';
        out.pct = pct;
        return out;
    };

    /**
     * How much of a fee goes back with a refund.
     *
     * The brands require a surcharge to be returned in proportion to the amount
     * refunded, so this is not optional and not the camp's choice. A convenience
     * fee is for a service already rendered and is not automatically returned —
     * but it is returned in full when the whole payment is, because a payment
     * reversed in its entirety was a payment that should not have happened.
     */
    F.refundShare = function (policy, o) {
        o = o || {};
        var p = F.normalize(policy);
        var feeCharged = Math.max(0, round2(num(o.feeCharged)));
        var paid = Math.max(0, round2(num(o.paymentAmount)));
        var refund = Math.max(0, round2(num(o.refundAmount)));
        if (feeCharged <= 0 || paid <= 0 || refund <= 0) return { fee: 0, reason: 'nothing_to_return' };

        var whole = refund >= paid - 0.004;
        if (p.mode === 'convenience') {
            return whole
                ? { fee: feeCharged, reason: 'whole_payment_reversed' }
                : { fee: 0, reason: 'convenience_fee_not_prorated' };
        }
        // Surcharge — and anything else that got this far — is proportional.
        var share = whole ? feeCharged : round2(feeCharged * (refund / paid));
        return { fee: Math.min(feeCharged, share), reason: 'proportional' };
    };

    /**
     * The sentence a parent has to be shown BEFORE they choose to pay by card.
     *
     * Disclosure before the choice is a card-brand requirement, not a courtesy,
     * and it is also what stops the fee becoming a dispute.
     */
    F.disclosure = function (policy, o) {
        o = o || {};
        var p = F.normalize(policy);
        var fmt = typeof o.fmt === 'function' ? o.fmt
            : function (n) { return '$' + round2(n).toFixed(2); };
        if (p.mode === 'off') return '';
        if (p.mode === 'surcharge') {
            var pct = F.effectivePct(p);
            if (!(pct > 0)) return '';
            return 'Paying by credit card adds a ' + pct + '% fee. Debit cards, bank ' +
                   'transfers, cheques and cash are not charged it.';
        }
        if (p.mode === 'convenience') {
            if (!(p.convenienceFlat > 0)) return '';
            return 'Paying online adds a ' + fmt(p.convenienceFlat) + ' fee per payment.';
        }
        var bits = [];
        if (p.cashDiscountPct > 0) bits.push(p.cashDiscountPct + '%');
        if (p.cashDiscountFlat > 0) bits.push(fmt(p.cashDiscountFlat));
        if (!bits.length) return '';
        return 'Prices shown include card processing. Paying by cheque or bank ' +
               'transfer takes ' + bits.join(' plus ') + ' off.';
    };

    /**
     * What an owner needs to read on the settings screen — including the parts
     * that are not this app's decision.
     */
    F.explain = function (policy, o) {
        o = o || {};
        var p = F.normalize(policy);
        var onDate = o.onDate || new Date().toISOString().slice(0, 10);
        var lines = [], blockers = [];

        if (p.mode === 'off') return { summary: 'No card fee is passed on.', blockers: [], notes: [] };

        if (p.mode === 'surcharge') {
            var pct = F.effectivePct(p);
            lines.push(pct + '% added to credit-card payments.');
            if (p.surchargePct > pct) {
                lines.push('Capped down from ' + p.surchargePct + '% — the brands allow the lesser of ' +
                           'your cost of acceptance and ' + F.MAX_SURCHARGE_PCT + '%.');
            }
            var ban = F.stateBan(p, onDate);
            if (ban) blockers.push(ban.note + '.');
            if (!p.state) blockers.push('Set the camp’s state: surcharging is banned in several.');
            if (!p.processorNotifiedOn) blockers.push('Give your processor 30 days’ written notice before switching this on.');
            if (!(pct > 0)) blockers.push('The surcharge is set to 0%, so nothing will be added.');
            return {
                summary: lines.join(' '),
                blockers: blockers,
                notes: [
                    'Debit, prepaid, FSA, HSA and Medicare Flex cards are never surcharged.',
                    'A card whose type we cannot read is not surcharged either — so a processor ' +
                        'that does not tell us credit from debit will collect nothing here.',
                    'Refunds return the surcharge in proportion, automatically.',
                    'Your processor agreement has the last word, and some states require the ' +
                        'total price to be disclosed rather than banning the fee.'
                ]
            };
        }

        if (p.mode === 'convenience') {
            lines.push('$' + p.convenienceFlat.toFixed(2) + ' added per ' +
                       (p.onlineOnly ? 'online ' : '') + 'payment.');
            if (!(p.convenienceFlat > 0)) blockers.push('The fee is $0, so nothing will be added.');
            return {
                summary: lines.join(' '),
                blockers: blockers,
                notes: [
                    'A convenience fee must be a FLAT amount — Visa and American Express do not ' +
                        'permit a percentage. A percentage is a surcharge and follows those rules instead.',
                    'It applies to debit cards and bank transfers as well as credit cards.',
                    'Cash and cheques are not charged it.'
                ]
            };
        }

        var d = [];
        if (p.cashDiscountPct > 0) d.push(p.cashDiscountPct + '%');
        if (p.cashDiscountFlat > 0) d.push('$' + p.cashDiscountFlat.toFixed(2));
        if (!d.length) blockers.push('No discount is set, so this does nothing.');
        return {
            summary: d.length ? d.join(' plus ') + ' off for paying by cheque or bank transfer.' : '',
            blockers: blockers,
            notes: [
                'Legal in every state, with no cap, no card-type rules and no notice to your processor.',
                'The card price must be the price you advertise.'
            ]
        };
    };

    if (typeof root !== 'undefined' && root) root.CampistryCardFees = F;
    if (typeof module !== 'undefined' && module.exports) module.exports = F;
})(typeof window !== 'undefined' ? window : null);
