/* =============================================================================
 * campistry_cancellation_policy.js — what a family gets back when they cancel.
 *
 * WHY THIS EXISTS. Every camp has a cancellation policy and they all have the
 * same shape: a non-refundable deposit, then bands by how far ahead of the
 * session the family pulls out ("more than 28 days: everything but the deposit;
 * 28-15 days: half; 14 days or fewer: nothing"), a prorated credit if they
 * leave partway through, and a full refund regardless of timing for families on
 * financial aid.
 *
 * Campistry had the machinery and none of the rule. BillingCore.creditWithdrawal
 * already understood {percent}, {amount} and {keepDeposit} — but the only caller
 * passed `policy == null ? 'none' : policy`, and nothing ever passed anything.
 * `'none'` credits zero. So every withdrawal silently kept 100% of the tuition:
 * not because a camp decided that, but because nobody had written the rule down.
 *
 * THE ARITHMETIC LIVES HERE, ONCE. The office dialog, the ledger entry and any
 * future parent-facing explanation all have to agree on the number, and three
 * copies of a refund calculation is three chances to disagree in front of a
 * family who is already unhappy.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never posts anything and never reads
 * app state. It takes a policy and the facts of one withdrawal and returns what
 * should happen. Posting stays in BillingCore, where the immutability rules are.
 * ========================================================================== */
(function (root) {
    'use strict';
    var C = {};

    function num(v, fallback) {
        var n = Number(v);
        return isFinite(n) ? n : (fallback || 0);
    }
    function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

    /** Whole days from `from` to `to`, using the DATE only — never the clock. */
    function daysBetween(fromISO, toISO) {
        var a = Date.parse(String(fromISO || '').slice(0, 10) + 'T00:00:00Z');
        var b = Date.parse(String(toISO || '').slice(0, 10) + 'T00:00:00Z');
        if (!isFinite(a) || !isFinite(b)) return null;
        return Math.round((b - a) / 86400000);
    }
    C.daysBetween = daysBetween;

    // The default is what the camps in the research actually publish. A camp
    // that never opens the setting still gets a defensible policy rather than
    // the silent keep-everything that was there before.
    C.DEFAULT_TIERS = [
        { minDaysBefore: 28, refundPct: 100 },
        { minDaysBefore: 15, refundPct: 50 },
        { minDaysBefore: 0,  refundPct: 0 }
    ];

    /**
     * A policy that is always safe to read. An unset policy is `enabled:false`,
     * which means "decide by hand" — NOT "credit nothing". The caller is
     * expected to ask rather than silently keep the money; resolve() says so.
     */
    C.normalize = function (raw) {
        var p = (raw && typeof raw === 'object') ? raw : {};
        var tiers = Array.isArray(p.tiers) && p.tiers.length ? p.tiers : C.DEFAULT_TIERS;
        tiers = tiers.map(function (t) {
            return {
                minDaysBefore: Math.max(0, Math.round(num(t && t.minDaysBefore, 0))),
                refundPct: Math.min(100, Math.max(0, num(t && t.refundPct, 0)))
            };
        }).sort(function (a, b) { return b.minDaysBefore - a.minDaysBefore; });

        return {
            enabled: !!p.enabled,
            // Kept whatever the band says, which is what "non-refundable" means.
            nonRefundableDeposit: Math.max(0, round2(num(p.nonRefundableDeposit, 0))),
            tiers: tiers,
            // Once the session has started: 'prorate' credits the part of the
            // session they will not attend; 'none' credits nothing.
            afterStart: p.afterStart === 'prorate' ? 'prorate' : 'none',
            // Camps in the research are near-unanimous on this one.
            financialAidFullRefund: p.financialAidFullRefund !== false
        };
    };

    /** The band that applies this many days before the session starts. */
    C.tierFor = function (policy, daysBefore) {
        var p = C.normalize(policy);
        if (daysBefore == null) return null;
        for (var i = 0; i < p.tiers.length; i++) {
            if (daysBefore >= p.tiers[i].minDaysBefore) return p.tiers[i];
        }
        return p.tiers.length ? p.tiers[p.tiers.length - 1] : null;
    };

    /**
     * What this withdrawal is worth back.
     *
     * o = { sessionStart, sessionEnd, onDate, tuitionNet, financialAid }
     *   tuitionNet — what is still owed/paid for THIS enrollment after any
     *                discounts already posted. BillingCore works this out; it is
     *                passed in so this stays a pure function.
     *
     * Returns { decided, creditAmount, keptAmount, pct, tier, basis, label }.
     * `decided:false` means the policy is off or the dates are unusable and a
     * human has to choose — the caller must NOT read creditAmount 0 as a
     * decision, which is exactly the bug this module exists to end.
     */
    C.resolve = function (policy, o) {
        o = o || {};
        var p = C.normalize(policy);
        var net = Math.max(0, round2(num(o.tuitionNet, 0)));
        var out = {
            decided: false, creditAmount: 0, keptAmount: net,
            pct: null, tier: null, basis: 'undecided',
            label: 'No cancellation policy set — decide what to credit'
        };
        if (net <= 0) {
            return { decided: true, creditAmount: 0, keptAmount: 0, pct: null,
                     tier: null, basis: 'nothing_owed',
                     label: 'Nothing was billed for this enrollment' };
        }
        if (!p.enabled) return out;

        // Financial aid: full credit whatever the calendar says.
        if (o.financialAid && p.financialAidFullRefund) {
            return { decided: true, creditAmount: net, keptAmount: 0, pct: 100,
                     tier: null, basis: 'financial_aid',
                     label: 'Financial aid — credited in full' };
        }

        var days = daysBetween(o.onDate, o.sessionStart);   // + = before it starts
        if (days == null) return out;                        // no usable dates

        // Already started.
        if (days < 0) {
            if (p.afterStart !== 'prorate') {
                return { decided: true, creditAmount: 0, keptAmount: net, pct: 0,
                         tier: null, basis: 'after_start',
                         label: 'Session already started — nothing credited' };
            }
            var total = daysBetween(o.sessionStart, o.sessionEnd);
            if (total == null || total <= 0) return out;
            var attended = Math.min(total, Math.max(0, -days));
            var unattended = Math.max(0, total - attended);
            var prorated = round2(net * (unattended / total));
            var creditP = Math.max(0, round2(prorated - p.nonRefundableDeposit));
            return {
                decided: true, creditAmount: Math.min(creditP, net),
                keptAmount: round2(net - Math.min(creditP, net)),
                pct: Math.round((unattended / total) * 100), tier: null,
                basis: 'prorated',
                label: unattended + ' of ' + total + ' days not attended — credited pro rata' +
                       (p.nonRefundableDeposit > 0 ? ', less the deposit' : '')
            };
        }

        var tier = C.tierFor(p, days);
        if (!tier) return out;
        var refundable = round2(net * (tier.refundPct / 100));
        var credit = Math.max(0, round2(refundable - p.nonRefundableDeposit));
        credit = Math.min(credit, net);
        return {
            decided: true, creditAmount: credit, keptAmount: round2(net - credit),
            pct: tier.refundPct, tier: tier, basis: 'tier',
            label: days + ' day' + (days === 1 ? '' : 's') + ' before the session — ' +
                   tier.refundPct + '% refundable' +
                   (p.nonRefundableDeposit > 0 ? ', less the deposit' : '')
        };
    };

    /**
     * The policy object BillingCore.creditWithdrawal expects.
     *
     * An explicit {amount} rather than {percent}: the deposit and the prorating
     * are already in the number, and handing BillingCore a percentage would make
     * it recompute against its own idea of net and quietly disagree with what
     * the office was shown.
     */
    C.corePolicyFor = function (result) {
        if (!result || !result.decided) return null;      // caller must ask a human
        return { amount: Math.max(0, round2(result.creditAmount)) };
    };

    /** One line for a confirm dialog. Money formatting is the caller's. */
    C.explain = function (result, fmt) {
        var f = typeof fmt === 'function' ? fmt : function (n) { return '$' + round2(n).toFixed(2); };
        if (!result) return '';
        if (!result.decided) return result.label;
        if (result.creditAmount <= 0) return result.label + ' — nothing credited';
        return 'Credit ' + f(result.creditAmount) +
               (result.keptAmount > 0 ? ', keep ' + f(result.keptAmount) : '') +
               ' (' + result.label + ')';
    };

    /** A sentence for the settings screen. */
    C.describe = function (policy) {
        var p = C.normalize(policy);
        if (!p.enabled) return 'Off — every withdrawal is decided by hand.';
        var bits = p.tiers.map(function (t) {
            return t.minDaysBefore > 0
                ? t.refundPct + '% if ' + t.minDaysBefore + '+ days before'
                : t.refundPct + '% otherwise';
        });
        if (p.nonRefundableDeposit > 0) bits.push('$' + p.nonRefundableDeposit + ' deposit never refunded');
        bits.push(p.afterStart === 'prorate' ? 'pro rata once started' : 'nothing once started');
        if (p.financialAidFullRefund) bits.push('financial aid always in full');
        return bits.join('; ') + '.';
    };

    if (typeof root !== 'undefined' && root) root.CampistryCancellationPolicy = C;
    if (typeof module !== 'undefined' && module.exports) module.exports = C;
})(typeof window !== 'undefined' ? window : null);
