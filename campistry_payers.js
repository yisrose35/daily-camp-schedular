/* =============================================================================
 * campistry_payers.js — who is paying for this camper, and how much of it.
 *
 * THE PROBLEM. A camper belongs to exactly one household. `famKey` resolves to a
 * single family, and when it cannot find one it invents a key from the last name.
 * The whole ledger is built on that: one household, one balance, one bill.
 *
 * Camps do not work that way. Parents divorce and split tuition. A grandparent
 * covers half. A shul fund or an agency pays a fixed $800 and the family covers
 * the rest. Today all of that lands on one household and the office reconciles it
 * by hand, which means the balance a parent sees is not the balance they owe.
 *
 * ── WHY THIS IS ADDITIVE AND NOT A REWRITE ─────────────────────────────────
 *
 * The family ledger is DERIVED, not stored: buildFamilyLedgers projects entries
 * out of enrollments, charges, credits and payments every time it runs. So the
 * total does not have to change to make the split visible — and it must not,
 * because every balance, statement and collections figure in the app depends on
 * it:
 *
 *     balance = Σ charges + Σ refunds − Σ credits − Σ payments
 *
 * That formula is untouched. A charge gains an OPTIONAL list of payer shares, a
 * payment gains an OPTIONAL payer, and this file derives a per-payer view on top.
 * A camp that never opens the feature has one payer — the household — and every
 * number it sees is the number it saw before.
 *
 * THE INVARIANT THAT MAKES IT SAFE: the shares of a charge always sum to exactly
 * the charge. Not approximately, not to within a cent. Whatever is not explicitly
 * assigned belongs to the household, including the rounding remainder — so the
 * per-payer figures always add up to the family figure, and the two views can
 * never disagree about what is owed.
 *
 * ── WHAT A PAYER IS ────────────────────────────────────────────────────────
 *
 * A household (the existing family, or a second one — the other parent) or an
 * ORGANIZATION (a fund, an agency, an employer). Organizations are the reason the
 * note field exists: "Tomchei Shabbos — approved 2026-03-14, ref #4471" is what an
 * office needs in August when the cheque has not arrived.
 * ========================================================================== */
(function (root) {
    'use strict';
    var P = {};

    /** A household pays like a family; an organization pays like an invoice. */
    P.KINDS = { household: 'Household', organization: 'Organization' };

    /** Money, to the cent, never a float surprise. */
    function cents(n) {
        var v = Math.round((Number(n) || 0) * 100);
        return Number.isFinite(v) ? v : 0;
    }
    function dollars(c) { return Math.round(Number(c) || 0) / 100; }
    P.cents = cents;
    P.dollars = dollars;

    function str(s) { return String(s == null ? '' : s).trim(); }

    /**
     * The payer registry, cleaned up.
     *
     * Accepts the stored object and returns one that is safe to iterate: no blank
     * ids, no missing names, kind always one of KINDS. An unknown kind becomes a
     * household, because a household is the kind that needs no extra handling.
     */
    P.normalize = function (payers) {
        var out = {};
        if (!payers || typeof payers !== 'object') return out;
        Object.keys(payers).forEach(function (id) {
            var p = payers[id];
            if (!p || typeof p !== 'object') return;
            var key = str(id);
            if (!key) return;
            out[key] = {
                id: key,
                name: str(p.name) || key,
                kind: P.KINDS[p.kind] ? p.kind : 'household',
                // A household payer may BE an existing family; that link is what
                // keeps the default payer and the family the same thing.
                familyKey: str(p.familyKey),
                contact: str(p.contact),
                email: str(p.email),
                phone: str(p.phone),
                note: str(p.note),
                archived: !!p.archived
            };
        });
        return out;
    };

    /** A payer id for a new payer, stable and safe to use as an object key. */
    P.idFor = function (name, kind) {
        var slug = str(name).toLowerCase().replace(/[^a-z0-9]+/g, '_')
                     .replace(/^_+|_+$/g, '').slice(0, 40);
        var prefix = (kind === 'organization') ? 'org_' : 'hh_';
        return prefix + (slug || String(Date.now()));
    };

    /**
     * Split one charge across its payers, to the cent.
     *
     * `shares` is what the office typed: a list of { payerId, amount } or
     * { payerId, pct }, in any mix, each with an optional note. Everything not
     * explicitly assigned goes to `defaultPayerId` — the household — as a single
     * remainder line.
     *
     * Returns [{ payerId, cents, amount, note, basis }] which ALWAYS sums to the
     * charge. The order of operations is the part that matters:
     *
     *   1. fixed amounts first, because a typed figure is a commitment — an
     *      organization that approved $800 pays $800, whatever the total turns out
     *      to be;
     *   2. percentages against the ORIGINAL total, not the remainder, because "50%"
     *      on a statement has to mean half the bill and not half of what is left
     *      after the fund paid;
     *   3. whatever is left to the household.
     *
     * Over-allocation is reported, never silently clamped — see validate(). This
     * function still returns something usable in that case, because a screen that
     * renders nothing is harder to correct than one showing an impossible split.
     */
    P.allocate = function (total, shares, defaultPayerId) {
        var totalC = cents(total);
        var def = str(defaultPayerId) || '__family__';
        var list = Array.isArray(shares) ? shares : [];
        var out = [], usedC = 0;

        // 1. explicit amounts
        list.forEach(function (s) {
            if (!s || s.amount == null || s.amount === '') return;
            var id = str(s.payerId);
            if (!id) return;
            var c = cents(s.amount);
            if (!c) return;
            out.push({ payerId: id, cents: c, amount: dollars(c),
                       note: str(s.note), basis: 'amount' });
            usedC += c;
        });

        // 2. percentages, against the original total
        list.forEach(function (s) {
            if (!s || s.pct == null || s.pct === '') return;
            if (s.amount != null && s.amount !== '') return;   // amount already won
            var id = str(s.payerId);
            if (!id) return;
            var pct = Number(s.pct) || 0;
            if (!pct) return;
            var c = Math.round(totalC * pct / 100);
            out.push({ payerId: id, cents: c, amount: dollars(c),
                       note: str(s.note), basis: 'pct', pct: pct });
            usedC += c;
        });

        // 3. the household takes the rest, INCLUDING the rounding remainder.
        //
        // Three payers at 33.33% of $100 come to $99.99; the missing cent is the
        // household's, not nobody's. This is the line that keeps the per-payer
        // figures adding up to the family figure.
        var restC = totalC - usedC;
        if (restC !== 0 || !out.length) {
            out.push({ payerId: def, cents: restC, amount: dollars(restC),
                       note: '', basis: 'remainder' });
        }
        return out;
    };

    /**
     * Is this split sane? Returns { ok, reason, message, overC } — never throws.
     *
     * The failure worth catching is over-allocation: shares adding to more than
     * the charge, which would show a household a negative balance and an
     * organization a bill nobody owes. Under-allocation is not an error at all,
     * because the household absorbing the rest is the normal case.
     */
    P.validate = function (total, shares) {
        var totalC = cents(total);
        var alloc = P.allocate(total, shares, '__family__');
        var explicitC = 0;
        alloc.forEach(function (a) { if (a.basis !== 'remainder') explicitC += a.cents; });

        if (explicitC > totalC) {
            var over = explicitC - totalC;
            return { ok: false, reason: 'over_allocated', overC: over,
                     message: 'Those shares come to ' + dollars(explicitC).toFixed(2)
                            + ' on a ' + dollars(totalC).toFixed(2) + ' charge — '
                            + dollars(over).toFixed(2) + ' too much.' };
        }
        // A negative share is somebody typing a credit into a split. It is not what
        // this is for, and it would flip a balance in a way nothing downstream
        // expects.
        var neg = (Array.isArray(shares) ? shares : []).filter(function (s) {
            return s && ((cents(s.amount) < 0) || (Number(s.pct) || 0) < 0);
        });
        if (neg.length) {
            return { ok: false, reason: 'negative_share',
                     message: 'A payer’s share cannot be negative. Issue a credit '
                            + 'against the charge instead.' };
        }
        return { ok: true, reason: 'ok', overC: 0, message: '' };
    };

    /**
     * Who owes what, across a whole family ledger.
     *
     * Takes the derived entries the app already builds and returns a per-payer
     * view: { payerId: { chargedC, paidC, balanceC, charged, paid, balance } },
     * plus a `total` that MUST equal the family's own balance. A caller can assert
     * that, and the test suite does — the moment the two disagree, one of the two
     * numbers on screen is a lie.
     *
     * A payment with no payerId belongs to the household, because before this
     * feature existed every payment did.
     */
    P.balances = function (o) {
        o = o || {};
        var entries = Array.isArray(o.entries) ? o.entries : [];
        var def = str(o.defaultPayerId) || '__family__';
        var acc = {};

        function bucket(id) {
            var k = str(id) || def;
            if (!acc[k]) acc[k] = { payerId: k, chargedC: 0, paidC: 0 };
            return acc[k];
        }

        entries.forEach(function (e) {
            if (!e || typeof e !== 'object') return;
            var amtC = cents(e.amount);
            var t = str(e.type);

            if (t === 'charge') {
                // A charge with no split is wholly the household's, which is what
                // every charge written before this feature is.
                P.allocate(e.amount, e.payers, def).forEach(function (a) {
                    bucket(a.payerId).chargedC += a.cents;
                });
            } else if (t === 'payment') {
                bucket(e.payerId).paidC += amtC;
            } else if (t === 'credit') {
                // A credit reduces what is owed. Split it the same way as the
                // charge it offsets when it says so, otherwise the household's.
                if (e.payers) {
                    P.allocate(e.amount, e.payers, def).forEach(function (a) {
                        bucket(a.payerId).chargedC -= a.cents;
                    });
                } else {
                    bucket(e.payerId).chargedC -= amtC;
                }
            } else if (t === 'refund') {
                // Money back to whoever paid it.
                bucket(e.payerId).paidC -= amtC;
            }
        });

        var out = {}, totalC = 0;
        Object.keys(acc).forEach(function (k) {
            var b = acc[k];
            var balC = b.chargedC - b.paidC;
            out[k] = {
                payerId: k,
                chargedC: b.chargedC, paidC: b.paidC, balanceC: balC,
                charged: dollars(b.chargedC), paid: dollars(b.paidC),
                balance: dollars(balC)
            };
            totalC += balC;
        });
        return { byPayer: out, totalC: totalC, total: dollars(totalC) };
    };

    /**
     * A one-line description of a split, for a statement or a ledger row.
     * Empty when there is nothing to say, so a caller can concatenate it blind.
     */
    P.describe = function (total, shares, payers, defaultPayerId) {
        var reg = P.normalize(payers);
        var alloc = P.allocate(total, shares, defaultPayerId);
        var parts = alloc.filter(function (a) { return a.cents !== 0; })
                         .map(function (a) {
            var who = (reg[a.payerId] && reg[a.payerId].name) || 'Household';
            return who + ' ' + dollars(a.cents).toFixed(2)
                 + (a.note ? ' (' + a.note + ')' : '');
        });
        return parts.length > 1 ? parts.join(' · ') : '';
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = P;
    if (root) root.CampistryPayers = P;
})(typeof window !== 'undefined' ? window : null);
