// =============================================================================
// campistry_deposit_match.js — decide which family a deposit belongs to
//
// The problem this exists to solve, in one line: the name on a Zelle payment is
// frequently NOT the name on the family record. It is a father's business, a
// mother's maiden name, a grandparent, a second parent who never changed their
// surname. Matching on the family name alone fails constantly, and every failure
// is manual office work.
//
// So we match on four signals, strongest first:
//
//   1. MEMO CODE  — a short per-family code the parent types into the Zelle memo.
//                   The only signal that is immune to the name problem entirely,
//                   because the parent controls it and it identifies the family
//                   directly. When present it is decisive.
//   2. PAYER ALIAS — "SHIMON'S HARDWARE LLC is the Klein family", learned once
//                   and remembered forever. This is what makes the name problem
//                   a ONE-TIME cost per payer instead of a recurring one.
//   3. HANDLE     — the Zelle email/phone already on file as a parent contact.
//   4. NAME       — fuzzy, order-independent, business-suffix-aware. Suggestion
//                   grade only; never strong enough to post money by itself.
//
// Pure and dependency-free so it runs in the browser, in Node tests, and in the
// deposit-inbox edge function without modification.
//
// ─────────────────────────────────────────────────────────────────────────────
// ON POSTING AUTOMATICALLY
//
// This module can decide to move money into a family ledger with no human in
// the loop. That is the entire point -- and it is also why `decide()` is far
// more willing to demote a match than to make one. A deposit sent to review
// costs one click. A deposit auto-posted to the WRONG family corrupts two
// ledgers at once, and nobody notices until a statement goes out.
//
// Hence: an ambiguous top two never auto-posts, an amount that overshoots the
// balance never auto-posts, a reversal never auto-posts, and dry-run mode posts
// nothing at all. Confidence alone is not sufficient authority.
// ─────────────────────────────────────────────────────────────────────────────
//
// Exposed as window.CampistryDepositMatch (browser) and module.exports (Node).
// =============================================================================
(function () {
    'use strict';

    var M = {};

    // ── tiers ────────────────────────────────────────────────────────────────

    M.SCORE = {
        MEMO_CODE:     100,
        ALIAS_HANDLE:   96,
        ALIAS_NAME:     95,
        PARENT_HANDLE:  90,
        FAMILY_NAME:    88,
        PARENT_NAME:    86,
        SURNAME:        62,
        TOKEN_OVERLAP:  55,
        WEAK:           40
    };

    M.DEFAULTS = {
        autoPostAt:   90,   // >= this and clean guardrails -> post with no human
        suggestAt:    40,   // >= this -> ranked suggestion in the reconcile inbox
        ambiguousGap:  5,   // top two closer than this -> never auto-post
        overpayGrace: 0.02, // fraction over balance still treated as "fits"
        dryRun:      false  // match, rank, explain -- but post nothing
    };

    M.settings = function (raw) {
        return Object.assign({}, M.DEFAULTS, raw || {});
    };

    // ── name normalization ───────────────────────────────────────────────────

    // Stripped so "SHIMON'S HARDWARE LLC" and "Shimons Hardware, L.L.C." are the
    // same payer -- a camp will see both spellings from the same account.
    var BIZ_SUFFIX = /\b(?:llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|pc|dba|trust|foundation|assoc(?:iation)?|enterprises?|holdings?|group|services?|solutions?)\b/g;

    var HONORIFIC = /\b(?:mr|mrs|ms|miss|dr|rabbi|rebbetzin|rev|hon|prof)\b/g;

    // Common informal <-> legal pairs. Deliberately short: a wrong nickname
    // mapping creates a confident match to the wrong household, which is worse
    // than no match. Only unambiguous pairs belong here.
    var NICKNAMES = {
        bob: 'robert', rob: 'robert', bobby: 'robert',
        bill: 'william', will: 'william', billy: 'william',
        dick: 'richard', rick: 'richard', rich: 'richard',
        jim: 'james', jimmy: 'james',
        joe: 'joseph', joey: 'joseph',
        mike: 'michael', mikey: 'michael',
        dave: 'david', davey: 'david',
        steve: 'stephen', steven: 'stephen',
        tom: 'thomas', tommy: 'thomas',
        chris: 'christopher', tony: 'anthony',
        dan: 'daniel', danny: 'daniel',
        matt: 'matthew', nick: 'nicholas',
        ben: 'benjamin', sam: 'samuel',
        alex: 'alexander', andy: 'andrew',
        ed: 'edward', eddie: 'edward',
        moshe: 'moses', shlomo: 'solomon',
        yankel: 'yaakov', yanky: 'yaakov',
        sruly: 'yisroel', srul: 'yisroel',
        chaim: 'haim', shimi: 'shimon',
        betty: 'elizabeth', liz: 'elizabeth', beth: 'elizabeth',
        sue: 'susan', suzy: 'susan',
        kathy: 'katherine', kate: 'katherine', katie: 'katherine',
        peggy: 'margaret', meg: 'margaret',
        jen: 'jennifer', jenny: 'jennifer',
        becky: 'rebecca', rivky: 'rivka',
        chani: 'chana', suri: 'sarah', sury: 'sarah'
    };

    // Punctuation is flattened to spaces before the suffix list runs, which
    // turns "L.L.C." into "l l c" -- three tokens that no longer match `llc`.
    // Rejoining runs of consecutive single letters puts them back together, so
    // "L.L.C.", "LLC" and "L L C" all reduce to the same token and get stripped.
    // Only runs of TWO OR MORE are joined, so a middle initial in "John A Smith"
    // is left alone.
    function joinInitials(s) {
        return s.replace(/\b(?:[a-z]\s+){1,}[a-z]\b/g, function (run) {
            return run.replace(/\s+/g, '');
        });
    }

    /** Lowercased, de-punctuated, suffix-stripped. The canonical comparison form. */
    M.normalize = function (raw) {
        return joinInitials(
                String(raw || '')
                    .toLowerCase()
                    .replace(/&/g, ' and ')
                    .replace(/['’`]/g, '')    // o'brien -> obrien, shimon's -> shimons
                    .replace(/[^a-z0-9]+/g, ' ')
            )
            .replace(HONORIFIC, ' ')
            .replace(BIZ_SUFFIX, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    };

    /** Normalized tokens with nicknames folded to their legal form. */
    M.tokens = function (raw) {
        return M.normalize(raw)
            .split(' ')
            .filter(function (t) { return t && t.length > 1; })
            .map(function (t) { return NICKNAMES[t] || t; });
    };

    /**
     * Every parent on a family record, whatever shape it is stored in.
     *
     * Campistry keeps contacts at families[k].households[].parents[] -- the
     * flat `parents` array only exists on synthesized/pending ledger families
     * and in test fixtures. Reading just one of the two silently loses every
     * real contact email and phone, which would disable the entire
     * handle-matching tier (a parent's own Zelle email is one of the strongest
     * signals available), so both are flattened here.
     */
    M.parentsOf = function (f) {
        var fam = f || {};
        var out = [];
        (fam.households || []).forEach(function (hh) {
            ((hh || {}).parents || []).forEach(function (p) { if (p) out.push(p); });
        });
        (fam.parents || fam.guardians || []).forEach(function (p) { if (p) out.push(p); });
        return out;
    };

    /** A phone/email handle reduced to a comparable key. */
    M.normalizeHandle = function (raw) {
        var s = String(raw || '').trim().toLowerCase();
        if (!s) return '';
        if (s.indexOf('@') > 0) return s;                 // email: as-is
        var digits = s.replace(/\D/g, '');
        return digits.length >= 10 ? digits.slice(-10) : ''; // phone: last 10
    };

    // ── memo codes ───────────────────────────────────────────────────────────
    //
    // Shape: AAA-NNNN. Three letters from the household name (so it looks
    // meaningful to a parent typing it) plus four digits derived from the
    // family key, the last of which is a CHECK DIGIT.
    //
    // The check digit is the whole reason this is safe to scan for across an
    // entire email: bank alerts are full of confirmation numbers and reference
    // ids that would otherwise look like codes. A random ABC-1234 fails the
    // check ~90% of the time, so a stray reference number does not silently
    // credit a family.

    function hash32(s) {
        var h = 0x811c9dc5;
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return h >>> 0;
    }

    function checkDigit(letters, three) {
        var basis = letters + three, sum = 0;
        for (var i = 0; i < basis.length; i++) sum += basis.charCodeAt(i) * (i + 1);
        return String(sum % 10);
    }

    /**
     * The stable memo code for a family. Same inputs always give the same code,
     * so it can be printed on statements without being stored anywhere.
     */
    M.memoCode = function (familyKey, familyName) {
        var letters = (String(familyName || '').toUpperCase().replace(/[^A-Z]/g, '') + 'XXX').slice(0, 3);
        var three = String(hash32(String(familyKey || familyName || '')) % 1000).padStart(3, '0');
        return letters + '-' + three + checkDigit(letters, three);
    };

    /** Does this look like a real Campistry code (and not a reference number)? */
    M.isValidMemoCode = function (code) {
        var m = String(code || '').toUpperCase().match(/^([A-Z]{3})-?([0-9]{3})([0-9])$/);
        if (!m) return false;
        return checkDigit(m[1], m[2]) === m[3];
    };

    /** Reverse lookup: which family does this code belong to? */
    M.familyForMemoCode = function (code, families) {
        var want = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!want || !M.isValidMemoCode(want)) return null;
        var keys = Object.keys(families || {});
        for (var i = 0; i < keys.length; i++) {
            var mine = M.memoCode(keys[i], (families[keys[i]] || {}).name).replace('-', '');
            if (mine === want) return keys[i];
        }
        return null;
    };

    // ── name similarity ──────────────────────────────────────────────────────

    /**
     * 0..1 order-independent token overlap. Order independence matters because
     * banks print "SMITH JOHN" as often as "JOHN SMITH".
     */
    M.nameSimilarity = function (a, b) {
        var ta = M.tokens(a), tb = M.tokens(b);
        if (!ta.length || !tb.length) return 0;
        var setB = {}, i;
        for (i = 0; i < tb.length; i++) setB[tb[i]] = true;
        var hits = 0;
        var seen = {};
        for (i = 0; i < ta.length; i++) {
            if (setB[ta[i]] && !seen[ta[i]]) { hits++; seen[ta[i]] = true; }
        }
        return hits / Math.max(ta.length, tb.length);
    };

    /** Family names in this codebase are households ("Klein Family", "The Kleins"). */
    function surnames(raw) {
        return M.tokens(String(raw || '').replace(/\bfamily\b|\bhousehold\b/gi, ''))
            .filter(function (t) { return t !== 'the' && t.length > 2; });
    }

    M.sharesSurname = function (a, b) {
        var sa = surnames(a), sb = surnames(b);
        if (!sa.length || !sb.length) return false;
        for (var i = 0; i < sa.length; i++) {
            for (var j = 0; j < sb.length; j++) {
                if (sa[i] === sb[j]) return true;
                // "kleins" vs "klein" -- plural households are written both ways.
                if (sa[i].replace(/s$/, '') === sb[j].replace(/s$/, '')) return true;
            }
        }
        return false;
    };

    // ── candidate scoring ────────────────────────────────────────────────────

    /**
     * Rank every family against one deposit.
     *
     * @param deposit  parser output: {amount, payerName, memo, memoCode, ...}
     * @param ctx      { families, aliases, ledgers }
     *                 families: { famKey: {name, parents:[{name,email,phone}], ...} }
     *                 aliases:  [ {familyKey, normalized, handle, kind} ]
     *                 ledgers:  { famKey: {balance, installments:[{amount}]} }
     * @returns candidates sorted best-first, each with the reasons behind it.
     */
    M.score = function (deposit, ctx) {
        var d = deposit || {};
        var families = (ctx && ctx.families) || {};
        var aliases = (ctx && ctx.aliases) || [];
        var ledgers = (ctx && ctx.ledgers) || {};

        var payer = d.payerName || '';
        var payerNorm = M.normalize(payer);
        var handleNorm = M.normalizeHandle(d.payerHandle || '');

        var scores = {};   // famKey -> {score, reasons[]}
        function bump(fk, score, reason) {
            if (!fk || !families[fk]) return;
            if (!scores[fk]) scores[fk] = { familyKey: fk, score: 0, reasons: [] };
            if (score > scores[fk].score) scores[fk].score = score;
            if (scores[fk].reasons.indexOf(reason) < 0) scores[fk].reasons.push(reason);
        }

        // 1. Memo code — decisive, and immune to the payer-name problem.
        var code = d.memoCode || '';
        if (code) {
            var byCode = M.familyForMemoCode(code, families);
            if (byCode) bump(byCode, M.SCORE.MEMO_CODE, 'Memo code ' + code);
        }

        // 2. Learned aliases.
        for (var a = 0; a < aliases.length; a++) {
            var al = aliases[a] || {};
            if (!al.familyKey) continue;
            var alHandle = M.normalizeHandle(al.handle);
            if (handleNorm && alHandle && alHandle === handleNorm) {
                bump(al.familyKey, M.SCORE.ALIAS_HANDLE, 'Known handle ' + al.handle);
            }
            var alNorm = al.normalized || M.normalize(al.displayName);
            if (payerNorm && alNorm && alNorm === payerNorm) {
                bump(al.familyKey, M.SCORE.ALIAS_NAME, 'Known payer "' + (al.displayName || payer) + '"');
            }
        }

        // 3 & 4. Contact handles and names already on the family record.
        Object.keys(families).forEach(function (fk) {
            var f = families[fk] || {};
            var parents = M.parentsOf(f);

            for (var p = 0; p < parents.length; p++) {
                var par = parents[p] || {};
                if (handleNorm) {
                    if (M.normalizeHandle(par.email) === handleNorm) bump(fk, M.SCORE.PARENT_HANDLE, 'Parent email on file');
                    if (M.normalizeHandle(par.phone) === handleNorm) bump(fk, M.SCORE.PARENT_HANDLE, 'Parent phone on file');
                }
                if (payerNorm && par.name && M.normalize(par.name) === payerNorm) {
                    bump(fk, M.SCORE.PARENT_NAME, 'Matches parent ' + par.name);
                }
            }

            if (!payerNorm) return;

            if (M.normalize(f.name) === payerNorm) {
                bump(fk, M.SCORE.FAMILY_NAME, 'Matches household name');
            } else {
                var sim = M.nameSimilarity(payer, f.name);
                var parentSim = 0, parentWho = '';
                for (var q = 0; q < parents.length; q++) {
                    var s2 = M.nameSimilarity(payer, (parents[q] || {}).name);
                    if (s2 > parentSim) { parentSim = s2; parentWho = (parents[q] || {}).name || ''; }
                }
                var best = Math.max(sim, parentSim);
                if (best >= 0.99) {
                    bump(fk, M.SCORE.PARENT_NAME, 'Matches ' + (parentSim >= sim ? parentWho : f.name));
                } else if (best >= 0.5) {
                    bump(fk, Math.round(M.SCORE.TOKEN_OVERLAP + best * 20),
                         'Partial name match with ' + (parentSim >= sim ? parentWho : f.name));
                } else if (M.sharesSurname(payer, f.name)) {
                    bump(fk, M.SCORE.SURNAME, 'Shares a surname with ' + f.name);
                }
            }
        });

        // Amount corroboration. Never enough on its own -- lots of families owe
        // the same round number -- but it separates a real match from a
        // coincidental surname when the office is choosing between two.
        Object.keys(scores).forEach(function (fk) {
            var led = ledgers[fk] || {};
            var bal = Number(led.balance) || 0;
            var amt = Number(d.amount) || 0;
            if (!amt) return;
            if (bal > 0 && Math.abs(bal - amt) < 0.01) {
                scores[fk].score += 12;
                scores[fk].reasons.push('Pays the balance exactly');
            } else if (Array.isArray(led.installments)) {
                for (var i = 0; i < led.installments.length; i++) {
                    if (Math.abs((Number(led.installments[i].amount) || 0) - amt) < 0.01) {
                        scores[fk].score += 10;
                        scores[fk].reasons.push('Matches an installment amount');
                        break;
                    }
                }
            }
        });

        return Object.keys(scores)
            .map(function (k) {
                var c = scores[k];
                c.score = Math.min(100, c.score);
                c.familyName = (families[k] || {}).name || '';
                return c;
            })
            .sort(function (x, y) { return y.score - x.score; });
    };

    // ── the decision ─────────────────────────────────────────────────────────

    /**
     * Turn ranked candidates into an action: 'auto' | 'review' | 'unmatched'.
     *
     * Every demotion carries a `guardrail` string, because "why didn't this post
     * by itself?" is the first question the office will ask and the answer must
     * be on screen, not in a log.
     */
    M.decide = function (deposit, ctx, settingsRaw) {
        var s = M.settings(settingsRaw);
        var d = deposit || {};
        var candidates = M.score(d, ctx);
        var top = candidates[0] || null;
        var runnerUp = candidates[1] || null;

        function out(decision, guardrail) {
            return {
                decision: decision,
                guardrail: guardrail || '',
                candidates: candidates.slice(0, 3),
                familyKey: (decision === 'auto' && top) ? top.familyKey : null,
                confidence: top ? top.score : 0
            };
        }

        // A return/NSF reversal reverses a payment the camp already booked and
        // may need to chase. It always goes to a person.
        if (Number(d.amount) < 0 || d.isReversal) return out('review', 'Return or reversal — needs review');

        if (!top || top.score < s.suggestAt) return out('unmatched', top ? 'No confident match' : 'No candidate families');
        if (top.score < s.autoPostAt) return out('review', '');

        if (s.dryRun) return out('review', 'Dry run — auto-posting is off');

        if (runnerUp && (top.score - runnerUp.score) < s.ambiguousGap) {
            return out('review', 'Two families match about equally (' + top.familyName + ' / ' + runnerUp.familyName + ')');
        }

        // Overpayment guard. A deposit meaningfully larger than the balance is
        // more often a wrong match or a mistyped amount than a prepayment, and
        // an auto-post here is the expensive kind of wrong.
        var bal = Number((((ctx || {}).ledgers || {})[top.familyKey] || {}).balance);
        if (isFinite(bal) && bal > 0 && Number(d.amount) > bal * (1 + s.overpayGrace) + 0.01) {
            return out('review', 'More than the ' + top.familyName + ' balance — confirm before posting');
        }

        return out('auto', '');
    };

    /**
     * The alias a confirmed match should create, so the same payer never needs
     * a human again. Returns null when there is nothing new worth learning.
     */
    M.aliasFrom = function (deposit, familyKey, existingAliases) {
        var d = deposit || {};
        var name = d.payerName || '';
        var handle = d.payerHandle || '';
        if (!familyKey || (!name && !handle)) return null;
        var norm = M.normalize(name);
        var hNorm = M.normalizeHandle(handle);
        var have = existingAliases || [];
        for (var i = 0; i < have.length; i++) {
            var al = have[i] || {};
            if (al.familyKey !== familyKey) continue;
            if (norm && (al.normalized || M.normalize(al.displayName)) === norm) return null;
            if (hNorm && M.normalizeHandle(al.handle) === hNorm) return null;
        }
        return {
            familyKey: familyKey,
            kind: d.kind || 'ach',
            displayName: name,
            normalized: norm,
            handle: handle,
            source: 'learned'
        };
    };

    // globalThis (not just window) so the exact same file runs unmodified in
    // Deno inside the deposit-inbox edge function -- see
    // tools/build_deposit_inbox.js, which inlines this file verbatim into the
    // single self-contained index.ts that gets deployed.
    if (typeof globalThis !== 'undefined') globalThis.CampistryDepositMatch = M;
    if (typeof window !== 'undefined') window.CampistryDepositMatch = M;
    if (typeof module !== 'undefined' && module.exports) module.exports = M;
})();
