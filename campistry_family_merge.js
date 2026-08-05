// =============================================================================
// campistry_family_merge.js — merging two family records into one
//
// Duplicate families happen constantly: a camper registers online while a
// sibling was added by hand, a CSV import spells the street differently, two
// parents fill the form from different addresses. The office ends up with the
// Weiss family twice, each holding half the money and half the campers.
//
// Merging is DESTRUCTIVE — one record is absorbed and deleted — so the rules
// live here, as pure functions over plain objects, rather than being spread
// through the modal that calls them.
//
// THE GUIDING RULE: a merge must never lose information.
//   • Money adds up. Balances, payments, charges and fee history concatenate.
//   • Field values do not overwrite each other blindly. A blank on the target
//     never wins over a real value on the source — that is exactly how custom
//     field values used to disappear.
//   • Where both records hold a DIFFERENT non-empty value, the target wins and
//     the loser is reported, so the merge can say what it had to choose
//     between instead of silently discarding it.
//
// Exposed as window.CampistryFamilyMerge (browser) and module.exports (tests).
// =============================================================================
(function () {
    'use strict';

    var M = {};

    function isBlank(v) {
        return v == null || v === '' || (typeof v === 'string' && !v.trim());
    }
    function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
    function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

    // Keys the merge computes itself; copying them field-by-field would double
    // money or resurrect a deleted record's identity.
    M.RESERVED_KEYS = ['camperIds', 'households', 'charges', 'feeHistory',
                       'balance', 'totalPaid', 'plan', 'name'];

    /**
     * Reconcile two records field-by-field.
     *
     * Non-empty always beats empty, in BOTH directions — this is what keeps
     * custom field values (cf_*) alive when the target record happens to be
     * the emptier of the two. A real conflict (two different non-empty values)
     * resolves to `target` and is listed in `conflicts` for the caller to show.
     *
     * @returns { merged, conflicts: [{ key, kept, discarded }], recovered: [key] }
     */
    M.reconcileFields = function (target, source, opts) {
        var skip = (opts && opts.skip) || [];
        var t = target || {}, s = source || {};
        var merged = Object.assign({}, t);
        var conflicts = [], recovered = [];

        Object.keys(s).forEach(function (key) {
            if (skip.indexOf(key) >= 0) return;
            var sv = s[key], tv = t[key];
            if (isBlank(sv)) return;                 // nothing to contribute
            if (isBlank(tv)) {                       // fill the gap
                merged[key] = sv;
                recovered.push(key);
                return;
            }
            // Arrays are additive rather than a conflict — two lists of notes
            // or documents are both real.
            if (Array.isArray(tv) && Array.isArray(sv)) {
                merged[key] = tv.concat(sv);
                return;
            }
            if (norm(tv) === norm(sv)) return;       // same answer, no conflict
            conflicts.push({ key: key, kept: tv, discarded: sv });
        });

        return { merged: merged, conflicts: conflicts, recovered: recovered };
    };

    /**
     * Merge two camper records for the same person, found under both families.
     * Custom fields, medical notes, documents and history all ride on the
     * camper, so this is where a careless merge does the most damage.
     */
    M.mergeCamperRecords = function (target, source) {
        var r = M.reconcileFields(target, source, { skip: ['history'] });
        // History is a timeline: interleave both and keep it ordered.
        var th = Array.isArray(target && target.history) ? target.history : [];
        var sh = Array.isArray(source && source.history) ? source.history : [];
        if (th.length || sh.length) {
            r.merged.history = th.concat(sh).sort(function (a, b) {
                return String((a && a.ts) || '').localeCompare(String((b && b.ts) || ''));
            }).slice(-200);
        }
        return r;
    };

    /** Households are the same household when a parent email or name matches. */
    function householdKey(hh) {
        var parents = (hh && hh.parents) || [];
        var email = '';
        parents.forEach(function (p) { if (!email && p && p.email) email = norm(p.email); });
        if (email) return 'e:' + email;
        var name = parents.length && parents[0] ? norm(parents[0].name) : '';
        var addr = norm(hh && hh.address).replace(/[^a-z0-9]/g, '');
        return 'n:' + name + '|' + addr;
    }

    M.mergeHouseholds = function (targetList, sourceList) {
        var out = (targetList || []).slice();
        var seen = {};
        out.forEach(function (hh) { seen[householdKey(hh)] = hh; });
        (sourceList || []).forEach(function (hh) {
            var k = householdKey(hh);
            if (!seen[k]) { seen[k] = hh; out.push(hh); return; }
            // Same household on both sides: fill blanks and add parents the
            // target does not already list (a second parent recorded on only
            // one of the two records).
            var existing = seen[k];
            var r = M.reconcileFields(existing, hh, { skip: ['parents'] });
            Object.assign(existing, r.merged);
            var known = {};
            (existing.parents || []).forEach(function (p) { known[norm(p && p.email) || norm(p && p.name)] = 1; });
            (hh.parents || []).forEach(function (p) {
                var pk = norm(p && p.email) || norm(p && p.name);
                if (pk && !known[pk]) { existing.parents = (existing.parents || []).concat([p]); known[pk] = 1; }
            });
        });
        return out;
    };

    /**
     * Plan the merge of `source` into `target`. Pure — returns what the merged
     * family should look like and what the caller still has to do (re-point
     * payments, merge duplicate campers, delete the source).
     *
     * @param target  the family record being kept
     * @param source  the family record being absorbed
     * @param opts.targetKey / opts.sourceKey  for the caller's bookkeeping
     * @returns {
     *   family, duplicateCampers, movedCampers,
     *   conflicts, recovered, planConflict, cardConflict, warnings
     * }
     */
    M.planMerge = function (target, source, opts) {
        opts = opts || {};
        var t = target || {}, s = source || {};

        var field = M.reconcileFields(t, s, { skip: M.RESERVED_KEYS });
        var fam = field.merged;

        // Campers present under BOTH families are the same child recorded
        // twice — the caller has to reconcile their roster records too.
        var tIds = (t.camperIds || []).slice();
        var sIds = (s.camperIds || []).slice();
        var have = {}; tIds.forEach(function (n) { have[norm(n)] = n; });
        var duplicates = [], moved = [];
        sIds.forEach(function (n) {
            if (have[norm(n)]) duplicates.push(n); else { moved.push(n); tIds.push(n); have[norm(n)] = n; }
        });
        fam.camperIds = tIds;

        fam.households = M.mergeHouseholds(t.households, s.households);
        fam.charges = (t.charges || []).concat(s.charges || []);
        fam.feeHistory = (t.feeHistory || []).concat(s.feeHistory || [])
            .sort(function (a, b) { return String((a && a.at) || '').localeCompare(String((b && b.at) || '')); });

        // Money adds. Two half-paid records become one fully-accounted one.
        fam.balance = round2((t.balance || 0) + (s.balance || 0));
        fam.totalPaid = round2((t.totalPaid || 0) + (s.totalPaid || 0));
        fam.name = t.name || s.name || '';

        var warnings = [];
        // Two monthly plans cannot be summed into one schedule — the due dates
        // and instalment counts differ. Keep the target's and say so.
        var planConflict = !!(t.plan && t.plan.installments && t.plan.installments.length
                           && s.plan && s.plan.installments && s.plan.installments.length);
        fam.plan = (t.plan && t.plan.installments && t.plan.installments.length) ? t.plan : (s.plan || null);
        if (planConflict) warnings.push('Both families had a monthly plan. The kept family\'s schedule stays; the other is discarded.');

        // Two saved cards are two Stripe customers; only one can be kept.
        var cardConflict = !!(t.cardOnFile && s.cardOnFile
                           && norm(t.stripeCustomerId) !== norm(s.stripeCustomerId));
        if (cardConflict) warnings.push('Both families had a card on file. The kept family\'s card stays.');
        if (!t.cardOnFile && s.cardOnFile) {
            fam.cardOnFile = s.cardOnFile;
            fam.stripeCustomerId = s.stripeCustomerId;
        }

        if (duplicates.length) {
            warnings.push(duplicates.length + ' camper' + (duplicates.length === 1 ? ' appears' : 's appear')
                + ' under both families and will be combined.');
        }

        return {
            family: fam,
            duplicateCampers: duplicates,
            movedCampers: moved,
            conflicts: field.conflicts,
            recovered: field.recovered,
            planConflict: planConflict,
            cardConflict: cardConflict,
            warnings: warnings,
            targetKey: opts.targetKey || null,
            sourceKey: opts.sourceKey || null
        };
    };

    /**
     * Families likely to be the same household. Scored on the same signals the
     * camper-level suggestions use — last name, address, parent email, parent
     * name — so the two agree on what "the same family" means.
     */
    M.findDuplicates = function (families, threshold) {
        var min = threshold || 2;
        var keys = Object.keys(families || {});
        var out = [];
        function sig(f) {
            var hh = (f.households && f.households[0]) || {};
            var p = (hh.parents && hh.parents[0]) || {};
            return {
                last: norm(f.name).replace(/\s*family$/, ''),
                addr: norm(hh.address).replace(/[^a-z0-9]/g, ''),
                email: norm(p.email),
                parent: norm(p.name)
            };
        }
        for (var i = 0; i < keys.length; i++) {
            for (var j = i + 1; j < keys.length; j++) {
                var a = sig(families[keys[i]]), b = sig(families[keys[j]]);
                var score = 0;
                if (a.last && a.last === b.last) score++;
                if (a.addr && a.addr === b.addr) score++;
                if (a.email && a.email === b.email) score++;
                if (a.parent && a.parent === b.parent) score++;
                if (score >= min) {
                    out.push({
                        keys: [keys[i], keys[j]],
                        names: [families[keys[i]].name, families[keys[j]].name],
                        score: score,
                        confidence: score >= 3 ? 'high' : 'medium'
                    });
                }
            }
        }
        return out.sort(function (x, y) { return y.score - x.score; });
    };

    if (typeof window !== 'undefined') window.CampistryFamilyMerge = M;
    if (typeof module !== 'undefined' && module.exports) module.exports = M;
})();
