// =============================================================================
// campistry_deposit_template.js — learn one bank's alert layout from one example
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// The generic parser (campistry_deposit_parser.js) reads an alert from a bank
// it has never seen by recognising how English states that money arrived. It
// is good, and it will never be perfect: there are thousands of banks and they
// reword alerts whenever marketing feels like it.
//
// But a camp has ONE bank account. Every Zelle payment a camp receives all
// season arrives in the same email layout, generated from the same template on
// the bank's side. So instead of parsing prose forever, ask once: here is one
// of your emails -- point at the name, the amount, the memo. Then reuse that
// answer for every alert that camp ever receives.
//
// THE PROBLEM WITH THE OBVIOUS IMPLEMENTATION
//
// Storing where the user highlighted -- "characters 142 to 159" -- is useless.
// The next email has a different name of a different length, and every offset
// after it shifts. The highlight has to be turned into something that survives
// the values changing.
//
// WHAT IS ACTUALLY STORED
//
// A bank alert is machine-generated: the BOILERPLATE around a value is fixed
// and only the value varies. So a highlight is stored as the text on either
// side of it:
//
//     "Here's the message from YISRAEL ROSENFELD: tst 1234"
//                             ^^^^^^^^^^^^^^^^^
//     prefix: "the message from "      suffix: ":"
//
// and extraction on a later email means: find the prefix, read until the
// suffix. The name changes; "the message from " does not.
//
// The prefix is grown leftward until it appears EXACTLY ONCE in the sample --
// "from " alone occurs five times in a Capital One alert and would match the
// wrong one.
//
// SAFETY
//
// Learning changes coverage, never authority. A payer name from a learned
// template scores exactly what a parsed one scores (88 at most, below the 90
// auto-post line), so a mislearned template can cost a miss or a suggestion a
// human rejects -- never a wrong credit. The amount is the exception and is
// range-checked on the way out.
//
// learn() REFUSES to return a template it cannot immediately replay against
// the very sample it was taught on. A template that cannot reproduce the
// answer it was just given will not do better on mail nobody has checked.
//
// Pure and dependency-free: browser (the teaching UI), Node (tests), Deno
// (the edge function, inlined by tools/build_deposit_inbox.js).
// =============================================================================
(function () {
    'use strict';

    var T = {};

    // Fields a camp can teach. `memo` matters more than it looks: the family
    // code travels in it, and the code is the only bank-independent signal
    // strong enough to post money by itself.
    T.FIELDS = ['payerName', 'amount', 'memo'];

    var MAX_PREFIX = 90;   // how far left we will look for a distinctive anchor
    var MAX_SUFFIX = 24;   // how far right; a value's terminator is always near

    /**
     * Collapse runs of spaces and tabs, keep newlines.
     *
     * The same alert wraps differently depending on the client that forwarded
     * it, so a template anchored on exact spacing breaks for reasons that have
     * nothing to do with the bank. Newlines are kept because they are often the
     * only thing terminating a value on its own line.
     */
    T.normalize = function (s) {
        return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ');
    };

    function escapeRe(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ── anchors ──────────────────────────────────────────────────────────────
    //
    // An anchor is a list of literal strings with ANY (null) standing in for a
    // value that varies from email to email.
    //
    // THE PART THAT MATTERS. The text to the left of a value may contain
    // ANOTHER value that varies. Capital One's memo line is
    //
    //     Here's the message from <PAYER>: <MEMO>
    //
    // so the memo's anchor runs straight through the payer's name. Stored as a
    // plain literal, the first version of this learned the anchor "D: " -- the
    // last letter of ROSENFELD -- which reproduced the sample perfectly and
    // then silently lost the memo on every other email that camp received.
    //
    // So any span the camp marked as a DIFFERENT field becomes a wildcard,
    // giving ["the message from ", ANY, ": "], which holds for every payer.
    var ANY = null;
    var ANY_SRC = '[^\\n]{0,80}';

    function anchorRe(parts, flags) {
        return new RegExp(parts.map(function (p) {
            return p === ANY ? ANY_SRC : escapeRe(p);
        }).join(''), flags || '');
    }

    function countMatches(text, parts) {
        var re = anchorRe(parts, 'g');
        var n = 0, guard = 0;
        while (re.exec(text) !== null) {
            n++;
            if (++guard > 500) break;
            if (re.lastIndex === 0) re.lastIndex++;
        }
        return n;
    }

    function hasLiteral(parts) {
        return parts.some(function (p) { return p !== ANY && String(p).trim(); });
    }

    /**
     * Slice text[from..to) into literal/wildcard parts, replacing any region
     * covered by another marked field with a wildcard. Returns null when
     * `from` lands inside such a region — an anchor must never begin halfway
     * through a value.
     */
    function segment(text, from, to, holes) {
        var parts = [], cursor = from;
        for (var i = 0; i < holes.length; i++) {
            var h = holes[i];
            if (h.end <= from || h.start >= to) continue;
            if (h.start < from) return null;
            if (h.start > cursor) parts.push(text.slice(cursor, h.start));
            parts.push(ANY);
            cursor = Math.min(h.end, to);
        }
        if (cursor < to) parts.push(text.slice(cursor, to));
        return parts.length ? parts : null;
    }

    /**
     * The anchor immediately left of `at`.
     *
     * Grown until it matches exactly once: "from " alone occurs five times in a
     * Capital One alert and would sooner or later select the wrong one, and a
     * wrong payer is worse than no payer.
     *
     * Among unique candidates, one starting on a word boundary wins. "®.\n\n"
     * is technically unique but means nothing and breaks the moment the bank
     * edits its punctuation; "sent you money with Zelle®.\n\n" survives.
     */
    // A unique anchor can still be a poor one. "of " is unique in a Capital One
    // alert and anchors the amount perfectly — until the bank writes "on behalf
    // of" somewhere above it. "in the amount of " carries enough context to
    // stay right. So uniqueness is required, and substance is preferred.
    var GOOD_ANCHOR_CHARS = 10;

    function literalLength(parts) {
        return parts.reduce(function (n, p) {
            return n + (p === ANY ? 0 : String(p).trim().length);
        }, 0);
    }

    function buildPrefix(text, at, holes) {
        var anyUnique = null, boundaryAligned = null;
        for (var len = 2; len <= MAX_PREFIX && at - len >= 0; len++) {
            var from = at - len;
            var parts = segment(text, from, at, holes);
            if (!parts || !hasLiteral(parts)) continue;
            if (countMatches(text, parts) !== 1) continue;
            if (!anyUnique) anyUnique = parts;

            var boundary = from === 0 || /[\s>:.,\n]/.test(text.charAt(from - 1));
            if (!boundary || parts[0] === ANY || !/^\S/.test(String(parts[0]))) continue;
            if (!boundaryAligned) boundaryAligned = parts;
            // Keep growing until the anchor says something, then stop.
            if (literalLength(parts) >= GOOD_ANCHOR_CHARS) return parts;
        }
        return boundaryAligned || anyUnique;
    }

    /** The one extraction path, shared by apply() and by suffix selection. */
    function extract(text, rule) {
        var parts = rule && rule.prefix;
        if (!parts || !parts.length) return null;
        var m = anchorRe(parts, '').exec(text);
        if (!m) return null;
        var from = m.index + m[0].length;
        var to;
        if (rule.suffix) {
            to = text.indexOf(rule.suffix, from);
            if (to < 0) to = text.indexOf('\n', from);
        } else {
            to = text.indexOf('\n', from);
        }
        if (to < 0) to = text.length;
        var value = text.slice(from, to).trim();
        return value || null;
    }

    /**
     * What terminates the value — chosen by VERIFICATION, not by assumption.
     *
     * The obvious implementation takes the characters that happen to follow
     * the highlight, and it is wrong in a way that looks right: Capital One
     * writes "in the amount of $5.00." so the suffix comes out as ".", and
     * searching forward for "." finds the decimal point INSIDE the amount.
     * The template then extracted "$5" from the very email it was taught on.
     *
     * So every candidate is tried against the sample and the first one that
     * actually reproduces the highlighted value wins.
     */
    function suffixFor(text, start, end, holes, prefixParts) {
        var limit = Math.min(end + MAX_SUFFIX, text.length);
        for (var i = 0; i < holes.length; i++) {
            if (holes[i].start >= end && holes[i].start < limit) limit = holes[i].start;
        }
        var want = text.slice(start, end).trim();

        var candidates = [];
        if (text.charAt(end) === '\n') candidates.push('\n');
        for (var len = 1; end + len <= limit; len++) {
            var cand = text.slice(end, end + len);
            if (!cand.trim()) continue;
            candidates.push(cand);
        }
        candidates.push('');   // run to end of line

        for (var c = 0; c < candidates.length; c++) {
            if (extract(text, { prefix: prefixParts, suffix: candidates[c] }) === want) {
                return candidates[c];
            }
        }
        return '';
    }

    /**
     * Turn one set of highlights into a reusable rule.
     *
     * `marks` is { field: {start, end} } as character offsets into `sample` —
     * exactly what a browser text selection gives you.
     *
     * Returns { ok, template } or { ok:false, errors } naming the field that
     * could not be learned, so the UI can ask that one question again rather
     * than making the camp start over.
     */
    T.learn = function (sample, marks, meta) {
        var text = T.normalize(sample);
        var out = { fields: {}, meta: meta || {} };
        var errors = [];

        // Where every marked value sits in the NORMALIZED text. These are the
        // regions that must become wildcards inside another field's anchor.
        var spans = {};
        T.FIELDS.forEach(function (field) {
            var m = (marks || {})[field];
            if (!m || typeof m.start !== 'number' || typeof m.end !== 'number') return;
            var value = T.normalize(String(sample).slice(m.start, m.end)).trim();
            if (!value) { errors.push(field + ': nothing was highlighted'); return; }
            var at = text.indexOf(value);
            if (at < 0) { errors.push(field + ': could not find the highlighted text'); return; }
            // EVERY occurrence matters, not just the first. Capital One prints
            // the payer twice -- once in the announcement line and again in
            // "Here's the message from <PAYER>:". Registering only the first
            // left the second looking like fixed boilerplate, so the memo's
            // anchor was learned as "ROSENFELD: " and worked for exactly one
            // family.
            var all = [];
            for (var i = text.indexOf(value); i !== -1; i = text.indexOf(value, i + value.length)) {
                all.push({ start: i, end: i + value.length });
            }
            spans[field] = { start: at, end: at + value.length, value: value, all: all };
        });

        Object.keys(spans).forEach(function (field) {
            var holes = [];
            Object.keys(spans).forEach(function (f) {
                if (f === field) return;
                holes = holes.concat(spans[f].all);
            });
            holes.sort(function (a, b) { return a.start - b.start; });

            var prefix = buildPrefix(text, spans[field].start, holes);
            if (!prefix) { errors.push(field + ': the surrounding text is not distinctive enough'); return; }
            out.fields[field] = {
                prefix: prefix,
                suffix: suffixFor(text, spans[field].start, spans[field].end, holes, prefix)
            };
        });

        if (!Object.keys(out.fields).length) {
            return { ok: false, errors: errors.length ? errors : ['nothing was highlighted'] };
        }

        // Replay against the very sample it was taught on. A rule that cannot
        // reproduce a known answer will not do better on mail nobody checked.
        var replay = T.apply(out, sample);
        Object.keys(spans).forEach(function (field) {
            if (!out.fields[field]) return;
            if (replay[field] !== spans[field].value) {
                errors.push(field + ': the rule did not reproduce what you highlighted');
                delete out.fields[field];
            }
        });

        if (errors.length) return { ok: false, errors: errors, template: out };
        return { ok: true, template: out };
    };

    /**
     * Read a new email with a learned template.
     *
     * Every field is independent: a template that still finds the amount but
     * has lost the payer (the bank reworded one line) returns the amount and
     * omits the payer, rather than failing wholesale. The caller then falls
     * back to the generic parser for that field alone.
     */
    T.apply = function (template, emailText) {
        var text = T.normalize(emailText);
        var fields = (template && template.fields) || {};
        var out = {};

        Object.keys(fields).forEach(function (field) {
            var value = extract(text, fields[field] || {});
            if (value) out[field] = value;
        });
        return out;
    };

    /**
     * How a template identifies the bank it belongs to.
     *
     * NOT the name a camp types -- "Chase", "chase bank", "JPM Chase" are the
     * same bank and three different strings. The sending domain is what the
     * bank actually controls and is stable across every alert it sends.
     */
    T.signature = function (fromAddress) {
        var m = String(fromAddress || '').toLowerCase().match(/@([^>\s]+)$/);
        var domain = m ? m[1] : String(fromAddress || '').toLowerCase().trim();
        // alerts.notify.chase.com and email.chase.com are one bank.
        var parts = domain.split('.').filter(Boolean);
        return parts.length > 2 ? parts.slice(-3).join('.') : domain;
    };

    /**
     * Does an anchor contain something that looks like a person's data?
     *
     * Anchors are meant to be boilerplate, and boilerplate is safe to share
     * between camps. But a highlight that stops one character early bakes a
     * letter of somebody's name into the anchor, and a suffix taken right after
     * an amount can swallow the next value whole. Anything carrying digits or a
     * long capitalised run is treated as contaminated: it still works for the
     * camp that taught it, it is just never offered to anyone else.
     */
    T.isShareable = function (template) {
        var fields = (template && template.fields) || {};
        return Object.keys(fields).every(function (f) {
            var r = fields[f] || {};
            var joined = (r.prefix || '') + ' ' + (r.suffix || '');
            if (/[0-9]/.test(joined)) return false;
            if (/\b[A-Z]{3,}(?:\s+[A-Z]{2,})+\b/.test(joined)) return false;
            if (/@/.test(joined)) return false;
            return true;
        });
    };

    if (typeof window !== 'undefined') window.CampistryDepositTemplate = T;
    if (typeof globalThis !== 'undefined') globalThis.CampistryDepositTemplate = T;
    if (typeof module !== 'undefined' && module.exports) module.exports = T;
})();
