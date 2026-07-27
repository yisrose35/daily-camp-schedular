// =============================================================================
// campistry_snacks_cash.js — canteen cash-out arithmetic
//
// Pure functions only, so the money rules can be unit-tested and so the
// manager dashboard, the POS terminal and (eventually) a server RPC all agree
// on the same answer. No DOM, no storage, no clock beyond the date passed in.
//
// The rules, in one place:
//   • Cash out draws physical money, so a camper's CREDIT LIMIT does not apply
//     — credit exists to let someone finish a purchase, not to hand out cash.
//   • A balanceFloor (a reserve the camp wants left on the account) is
//     respected.
//   • cashDailyMax caps how much one camper can take out per day. It is
//     separate from dailyLimit, which caps canteen SPENDING.
//   • cashAllowNegative lets a camp override the balance check entirely.
//
// Exposed as window.SnacksCash (browser) and module.exports (tests).
// =============================================================================
(function () {
    'use strict';

    var SnacksCash = {};

    var DEFAULTS = {
        cashDailyMax: 20,
        cashReasonRequired: true,
        cashAllowNegative: false
    };
    SnacksCash.DEFAULTS = DEFAULTS;

    function money(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }
    SnacksCash.money = money;

    /** Sum of cash already taken out by one camper on `date`. */
    SnacksCash.takenOn = function (transactions, camper, date) {
        return money((transactions || []).reduce(function (s, t) {
            if (!t || t.kind !== 'cash_out') return s;
            if (t.camper !== camper) return s;
            if (date && t.date !== date) return s;
            return s + Math.abs(parseFloat(t.amount) || 0);
        }, 0));
    };

    /** Sum of ALL cash taken out on `date`, across every camper. */
    SnacksCash.paidOutOn = function (transactions, date) {
        return money((transactions || []).reduce(function (s, t) {
            if (!t || t.kind !== 'cash_out') return s;
            if (date && t.date !== date) return s;
            return s + Math.abs(parseFloat(t.amount) || 0);
        }, 0));
    };

    /**
     * How much cash this camper may take out right now.
     *
     * @param {object} o  { account, transactions, camper, date, settings }
     * @returns {object}  { balance, max, reason, takenToday }
     *   max     — dollars available (Infinity when cashAllowNegative is on)
     *   reason  — why max is 0, for display; '' when there's room
     */
    SnacksCash.limit = function (o) {
        o = o || {};
        var cfg = Object.assign({}, DEFAULTS, o.settings || {});
        var a = o.account || {};
        var balance = money(a.balance);
        var floor = money(a.balanceFloor);
        var takenToday = SnacksCash.takenOn(o.transactions, o.camper, o.date);

        var max = cfg.cashAllowNegative ? Infinity : Math.max(0, money(balance - floor));
        var reason = (max === 0) ? 'No available balance' : '';

        var dailyMax = money(cfg.cashDailyMax);
        if (dailyMax > 0) {
            var left = Math.max(0, money(dailyMax - takenToday));
            if (left < max) {
                max = left;
                reason = (left === 0)
                    ? 'Daily cash-out limit of $' + dailyMax.toFixed(2) + ' already reached'
                    : '';
            }
        }
        return { balance: balance, max: max, reason: reason, takenToday: takenToday };
    };

    /**
     * Validate a proposed withdrawal. Called both when the modal renders (to
     * enable/disable the button) and again at write time, because the modal can
     * sit open while a POS charge lands from another device.
     *
     * @returns {object} { ok, error, amount, limit }
     */
    SnacksCash.validate = function (o) {
        o = o || {};
        var cfg = Object.assign({}, DEFAULTS, o.settings || {});
        var lim = SnacksCash.limit(o);
        var amount = money(o.amount);

        if (!o.camper) return { ok: false, error: 'Pick a camper', amount: amount, limit: lim };
        if (amount <= 0) return { ok: false, error: 'Enter an amount', amount: amount, limit: lim };
        if (cfg.cashReasonRequired && !String(o.note || '').trim()) {
            return { ok: false, error: 'A reason is required for cash out', amount: amount, limit: lim };
        }
        if (lim.reason) return { ok: false, error: lim.reason, amount: amount, limit: lim };
        if (lim.max !== Infinity && amount > lim.max + 1e-9) {
            return { ok: false, error: 'Only $' + lim.max.toFixed(2) + ' available to take out', amount: amount, limit: lim };
        }
        return { ok: true, error: '', amount: amount, limit: lim };
    };

    /**
     * The ledger row for a withdrawal.
     *
     * Written as a `debit` so _reconcileBalances() — which rebuilds every
     * balance from the transaction list — subtracts it. `kind: 'cash_out'` is
     * what lets revenue reporting and the drawer tell it apart from a sale.
     */
    SnacksCash.buildTransaction = function (o) {
        o = o || {};
        var amount = money(o.amount);
        var note = String(o.note || '').trim();
        return {
            time: o.time || '',
            camper: o.camper || '',
            items: 'Cash out' + (note ? ' — ' + note : ''),
            amount: amount,
            type: 'debit',
            kind: 'cash_out',
            note: note,
            by: String(o.by || '').trim(),
            date: o.date || ''
        };
    };

    if (typeof window !== 'undefined') window.SnacksCash = SnacksCash;
    if (typeof module !== 'undefined' && module.exports) module.exports = SnacksCash;
})();
