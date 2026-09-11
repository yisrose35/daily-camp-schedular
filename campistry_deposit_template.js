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
    var MAX_SUFFIX = 24;
    // No payer name, amount or memo is longer than this. A longer capture is
    // always a rule that has come loose, never a real value.
    var MAX_VALUE = 120;   // how far right; a value's terminator is always near

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
        var eol = text.indexOf('\n', from);
        if (eol < 0) eol = text.length;

        var to;
        if (rule.suffix && rule.suffix !== '\n') {
            to = text.indexOf(rule.suffix, from);
            // NEVER past the end of the line. When a bank restructures the
            // line, the suffix is missing from it and indexOf happily finds the
            // next occurrence hundreds of characters away -- this returned a
            // "payer name" containing three paragraphs of the email. Every
            // field here lives on one line, so the line end is a hard stop.
            if (to < 0 || to > eol) to = eol;
        } else {
            to = eol;
        }
        var value = text.slice(from, to).trim();
        if (!value || value.length > MAX_VALUE) return null;
        return value;
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

    // ── the line rule: where to look ─────────────────────────────────────────
    //
    // The anchor above says "find this phrase, read what follows". This says
    // something different and complementary: the value lives ON THIS LINE, in
    // THIS SLOT, and here is what the rest of that line looks like.
    //
    // The two fail in different ways, which is the whole reason for having
    // both:
    //
    //   anchor     survives lines being inserted or removed above it;
    //              breaks if the bank rewords that one phrase.
    //   line rule  survives rewording elsewhere and a promo banner appearing
    //              at the top; breaks if the bank restructures that line.
    //
    // Character offsets would be useless -- a longer name shifts everything
    // after it -- but the SHAPE of the line is fixed, because the bank
    // generates it from a template. So the line is stored as a pattern with
    // the value as a capture, digits generalised, and spacing loosened:
    //
    //   "YISRAEL ROSENFELD has just sent you money ... of $5.00."
    //     -> ^(.+?)\s+has\s+just\s+sent\s+you\s+money\s+...\s+of\s+\$\d+\.\d+\.$
    //
    // which reads MIRIAM T. WEISSBERGER and $1,250.00 just as happily.
    var MAX_LINE_RULE = 400;

    function lineBounds(text, at) {
        var start = text.lastIndexOf('\n', at - 1) + 1;
        var end = text.indexOf('\n', at);
        if (end < 0) end = text.length;
        return { start: start, end: end };
    }

    /** One literal chunk of a line, generalised so ordinary variation survives. */
    function literalToPattern(chunk) {
        return escapeRe(chunk)
            .replace(/[0-9]+/g, '\\d+')     // amounts, dates, account digits
            .replace(/[  ]+/g, '\\s+'); // re-wrapping, double spaces
    }

    /**
     * Build the line rule for a value, masking the value as a capture and any
     * OTHER marked value on the same line as a wildcard.
     */
    function buildLineRule(text, me, holes, lineNo, totalLines) {
        var b = lineBounds(text, me.start);
        var line = text.slice(b.start, b.end);
        if (!line.trim() || line.length > MAX_LINE_RULE) return null;

        // Everything on this line that is not fixed: this value (captured) and
        // any other marked value (wildcarded).
        var spans = [{ start: me.start, end: me.end, capture: true }];
        holes.forEach(function (h) {
            if (h.start >= b.start && h.end <= b.end) spans.push({ start: h.start, end: h.end, capture: false });
        });
        spans.sort(function (a, c) { return a.start - c.start; });

        var src = '^', cursor = b.start;
        for (var i = 0; i < spans.length; i++) {
            var sp = spans[i];
            if (sp.start < cursor) continue;                 // overlapping marks
            src += literalToPattern(text.slice(cursor, sp.start));
            src += sp.capture ? '(.+?)' : '.+?';
            cursor = sp.end;
        }
        src += literalToPattern(text.slice(cursor, b.end)) + '$';

        return {
            re: src,
            // Kept as a tiebreak only. Counted from BOTH ends because banks add
            // marketing at the top far more often than at the bottom, so the
            // distance from the end is usually the steadier of the two.
            fromTop: lineNo,
            fromBottom: totalLines - 1 - lineNo
        };
    }

    /**
     * Read a value using the line rule.
     *
     * When several lines match the shape -- two payments summarised in one
     * email, say -- the remembered position decides between them rather than
     * the first one silently winning.
     */
    function extractByLine(text, rule) {
        if (!rule || !rule.re) return null;
        var re;
        try { re = new RegExp(rule.re); } catch (e) { return null; }
        var lines = text.split('\n');
        var hits = [];
        for (var i = 0; i < lines.length; i++) {
            var m = re.exec(lines[i]);
            if (m && m[1] && m[1].trim()) hits.push({ line: i, value: m[1].trim() });
        }
        if (!hits.length) return null;
        if (hits.length === 1) return hits[0].value;

        var best = hits[0], bestCost = Infinity;
        for (var j = 0; j < hits.length; j++) {
            var cost = Math.min(
                Math.abs(hits[j].line - rule.fromTop),
                Math.abs((lines.length - 1 - hits[j].line) - rule.fromBottom)
            );
            if (cost < bestCost) { bestCost = cost; best = hits[j]; }
        }
        return best.value;
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
        var totalLines = text.split('\n').length;
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
            var lineNo = text.slice(0, spans[field].start).split('\n').length - 1;
            var line = buildLineRule(text, spans[field], holes, lineNo, totalLines);

            if (!prefix && !line) {
                errors.push(field + ': the surrounding text is not distinctive enough');
                return;
            }
            out.fields[field] = {
                prefix: prefix || null,
                suffix: prefix ? suffixFor(text, spans[field].start, spans[field].end, holes, prefix) : '',
                line: line
            };
        });

        if (!Object.keys(out.fields).length) {
            return { ok: false, errors: errors.length ? errors : ['nothing was highlighted'] };
        }

        // Replay against the very sample it was taught on. A rule that cannot
        // reproduce a known answer will not do better on mail nobody checked.
        // Replay BOTH methods against the sample and keep only what works. A
        // rule that cannot reproduce the answer it was just given will not do
        // better on mail nobody has checked, and a half-right template is
        // worse than none: it looks like it is working.
        var replay = T.read(out, sample);
        Object.keys(spans).forEach(function (field) {
            var f = out.fields[field];
            if (!f) return;
            var want = spans[field].value;
            var got = replay[field] || {};
            if (f.prefix && got.byAnchor !== want) { f.prefix = null; f.suffix = ''; }
            if (f.line && got.byLine !== want) { f.line = null; }
            if (!f.prefix && !f.line) {
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
    /**
     * Is this value even the right SHAPE for this field?
     *
     * When one of the two methods dies, the survivor answers alone and with no
     * second opinion. A restructured line leaves the anchor matching in the
     * wrong place, and it returns "You got $1,250.00 from MIRIAM T.
     * WEISSBERGER via Zelle®." as the payer -- confidently, one line, right
     * length. Nothing about the extraction can tell it is wrong; only knowing
     * what a payer name looks like can.
     *
     * Deliberately loose. This rejects obvious nonsense, not unusual names.
     */
    T.plausible = function (field, value) {
        var v = String(value || '').trim();
        if (!v || v.length > MAX_VALUE) return false;

        if (field === 'amount') {
            return /[0-9]/.test(v) && /^[^A-Za-z]*[$€£]?\s?[0-9][0-9,]*(?:\.[0-9]{1,2})?[^A-Za-z]*$/.test(v);
        }
        if (field === 'payerName') {
            if (!/[A-Za-z]{2}/.test(v)) return false;
            if (/[$€£]/.test(v)) return false;              // an amount, not a name
            if (v.split(/\s+/).length > 6) return false;    // a sentence, not a name
            return true;
        }
        // memo: anything short and non-empty; the family code is found inside it
        return v.length <= MAX_VALUE;
    };

    /**
     * Read an email with both methods and report what each one said.
     *
     * { field: { value, byAnchor, byLine, agree } }
     *
     * `agree` is the useful part. Two independent rules, learned from the same
     * highlight but breaking under different conditions, arriving at the same
     * answer is real evidence the template still fits the mail this bank is
     * sending today. Disagreement means the layout moved under us, and the
     * honest response is to hand it to a person rather than pick a winner.
     */
    T.read = function (template, emailText) {
        var text = T.normalize(emailText);
        var fields = (template && template.fields) || {};
        var out = {};

        Object.keys(fields).forEach(function (field) {
            var rule = fields[field] || {};
            var byAnchor = rule.prefix ? extract(text, rule) : null;
            var byLine = rule.line ? extractByLine(text, rule.line) : null;
            if (byAnchor && !T.plausible(field, byAnchor)) byAnchor = null;
            if (byLine && !T.plausible(field, byLine)) byLine = null;
            if (!byAnchor && !byLine) return;
            out[field] = {
                byAnchor: byAnchor,
                byLine: byLine,
                // Where only one method survives, use it: a partially intact
                // template still beats falling back to generic prose parsing.
                value: (byAnchor && byLine)
                    ? (byAnchor === byLine ? byAnchor : byAnchor)
                    : (byAnchor || byLine),
                agree: !!(byAnchor && byLine && byAnchor === byLine)
            };
        });
        return out;
    };

    /** The values alone, for callers that do not care how they were found. */
    T.apply = function (template, emailText) {
        var read = T.read(template, emailText);
        var out = {};
        Object.keys(read).forEach(function (f) { out[f] = read[f].value; });
        return out;
    };

    /**
     * Fields where the two methods disagreed — the template is drifting and
     * this bank's layout has changed. The caller routes these to a human and
     * flags the template for re-teaching.
     */
    T.conflicts = function (template, emailText) {
        var read = T.read(template, emailText);
        return Object.keys(read).filter(function (f) {
            return read[f].byAnchor && read[f].byLine && !read[f].agree;
        });
    };

    /**
     * A stable fingerprint of the RULES, and nothing else.
     *
     * This is what corroboration is counted over, so it must come out
     * identical when two camps independently teach the same layout -- and
     * different the moment anything real differs. Field order is sorted
     * because object key order is not a promise, and meta (the bank label the
     * camp typed, when it was taught) is deliberately excluded: it varies
     * between camps that learned exactly the same thing.
     *
     * FNV-1a, same as the deposit fingerprint. A dedupe key, never a security
     * boundary -- nothing is trusted because its hash matches, only counted.
     */
    T.hash = function (template) {
        var fields = (template && template.fields) || {};
        var basis = Object.keys(fields).sort().map(function (f) {
            var r = fields[f] || {};
            var prefix = (r.prefix || []).map(function (p) {
                return p === ANY ? ' ANY ' : String(p);
            }).join('');
            var line = r.line ? String(r.line.re) : '';
            return [f, prefix, String(r.suffix || ''), line].join('');
        }).join('');

        var h = 0x811c9dc5;
        for (var i = 0; i < basis.length; i++) {
            h ^= basis.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return 'tpl_' + ('00000000' + h.toString(16)).slice(-8) +
               '_' + ('0000' + (basis.length % 65536).toString(16)).slice(-4);
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
