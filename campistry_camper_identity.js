// =============================================================================
// campistry_camper_identity.js — two campers may share a name
//
// Pure functions. No DOM, no storage.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM
//
// `roster` is keyed by the camper's full name — `roster['Malky Stein']` — and so
// is nearly everything downstream: `families[].camperIds` holds names,
// `enrollments[].camperName` is a name, `bunkAsgn[bunk]` is a list of names,
// `snacks.accounts` and its transaction ledger are keyed by name, and so are the
// Go addresses, the health records and the print sheets. Around 1,200 references
// across 45 client files and 88 server-side ones assume "a camper IS a name".
//
// So saveCamper has to refuse a second camper with the same name:
//
//     if(!editingCamper && roster[full]){ toast('Already exists','error'); return }
//
// Without that guard the new record would be merged onto the existing one and
// two children would become one. With it, a camp simply cannot enrol two kids
// called the same thing — which is an ordinary thing for a camp to need.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FIX, AND WHY IT IS SHAPED THIS WAY
//
// The obvious answer is to re-key everything by `camperId`, which already exists
// on every record. That is the right endpoint and the wrong next step: it means
// rewriting ~1,200 call sites, many of them on paths that move money, in one go.
//
// So the key stays a STRING and stays unique. The first Malky Stein keeps the
// key `'Malky Stein'`. A second one gets `'Malky Stein #102'`, where 102 is her
// camperId, and carries `displayName: 'Malky Stein'`. Every existing lookup
// keeps working unchanged, because it was always looking up "the key" and the
// key is still a unique string — it just is not always identical to the name.
//
// Two consequences worth being explicit about:
//
//   1. NOTHING BREAKS AND NOTHING MOVES. Existing campers keep the keys they
//      have. This is additive: the only records with a suffixed key are ones
//      that could not have existed before at all.
//
//   2. DISPLAY IS THE ONLY WORK LEFT. A screen that prints the key raw will show
//      `Malky Stein #102`. `labelOf()` is the fix, and the degradation if a
//      screen has not been reached yet is cosmetic — a visible suffix, never a
//      wrong balance or a lost record. `labelOf` also strips the suffix as a
//      fallback when `displayName` is missing, so even an un-migrated caller that
//      routes through it gets the clean name.
//
// The suffix is the camperId rather than a counter on purpose: it is stable (a
// counter would renumber if an earlier duplicate were deleted), and it is
// meaningful to an office, who already sees camper IDs on invoices and bank
// memos.
// =============================================================================

(function () {
    'use strict';

    var I = {};

    // A key we generated for a duplicate: "<name> #<camperId>".
    var SUFFIX = /\s#(\d+)$/;

    /** The camper's real name, whatever their key happens to be. */
    I.labelOf = function (rec, key) {
        if (rec && rec.displayName) return String(rec.displayName);
        // No displayName: either an ordinary camper whose key IS their name, or a
        // suffixed key written before displayName existed. Strip the suffix so a
        // caller that routes through here never shows "#102" to a parent.
        return String(key == null ? '' : key).replace(SUFFIX, '');
    };

    /** Does this key carry a disambiguating suffix? */
    I.isSuffixed = function (key) { return SUFFIX.test(String(key == null ? '' : key)); };

    /** The camperId embedded in a suffixed key, or null. */
    I.idFromKey = function (key) {
        var m = SUFFIX.exec(String(key == null ? '' : key));
        return m ? Number(m[1]) : null;
    };

    /**
     * A free roster key for `displayName`.
     *
     * Returns the plain name when it is available — so the common case is
     * unchanged and no existing camp ever sees a suffix. Only a genuine
     * collision gets "<name> #<camperId>".
     *
     * `camperId` is required for the suffix to be stable. Without one this falls
     * back to a counter, which is worse (it renumbers if an earlier duplicate is
     * deleted) but still better than refusing to record the child.
     */
    I.uniqueKey = function (roster, displayName, camperId) {
        var name = String(displayName == null ? '' : displayName).trim();
        if (!name) return '';
        roster = roster || {};
        if (!Object.prototype.hasOwnProperty.call(roster, name)) return name;

        if (camperId != null && String(camperId) !== '') {
            var keyed = name + ' #' + camperId;
            if (!Object.prototype.hasOwnProperty.call(roster, keyed)) return keyed;
        }
        // Same name AND same id already on file — or no id at all. Walk a counter.
        for (var n = 2; n < 1000; n++) {
            var alt = name + ' #' + n;
            if (!Object.prototype.hasOwnProperty.call(roster, alt)) return alt;
        }
        return name + ' #' + Date.now().toString(36);
    };

    /**
     * Everyone currently sharing a display name, keyed by that name. Used to warn
     * an office that two records are easy to confuse, and to decide when a screen
     * must show something extra (a bunk, an id) to tell them apart.
     */
    I.duplicates = function (roster) {
        var byName = {}, out = {};
        Object.keys(roster || {}).forEach(function (k) {
            var label = I.labelOf(roster[k], k);
            (byName[label] = byName[label] || []).push(k);
        });
        Object.keys(byName).forEach(function (label) {
            if (byName[label].length > 1) out[label] = byName[label];
        });
        return out;
    };

    /**
     * How to show a camper when a screen lists several and two share a name.
     * A bare name is ambiguous; a raw key is ugly. Prefer a real distinguishing
     * attribute the office already recognises — the bunk — and fall back to the
     * camper id.
     */
    I.disambiguate = function (roster, key) {
        var rec = (roster || {})[key] || {};
        var label = I.labelOf(rec, key);
        var dups = I.duplicates(roster);
        if (!dups[label]) return label;
        if (rec.bunk) return label + ' (' + rec.bunk + ')';
        if (rec.camperId != null) return label + ' (#' + rec.camperId + ')';
        return label;
    };

    if (typeof window !== 'undefined') window.CamperIdentity = I;
    if (typeof module !== 'undefined' && module.exports) module.exports = I;
})();
