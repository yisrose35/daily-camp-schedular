// @ts-nocheck
// =============================================================================
// AUTO-GENERATED — DO NOT EDIT.
//
// Deploy this file as the ENTIRE deposit-inbox function. It is deliberately
// self-contained: the Supabase Dashboard flattens a function to source/index.ts,
// so any relative import of a sibling file fails to resolve at deploy time.
//
// Generated from campistry_deposit_parser.js + campistry_deposit_match.js
// + tools/deposit_inbox_handler.ts by tools/build_deposit_inbox.js.
// Edit those, then run:  node tools/build_deposit_inbox.js
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── campistry_deposit_parser.js ───────────────────────────────
// =============================================================================
// campistry_deposit_parser.js — turn a bank alert into a structured deposit
//
// Zelle has no merchant API and a plain ACH credit has no API either. The ONLY
// two things that can tell Campistry money arrived are:
//
//   1. the alert email the bank sends the moment it lands, and
//   2. the transaction descriptor on the bank statement / aggregator feed.
//
// This module parses both into the same shape. It is deliberately pure and
// dependency-free so the exact same code runs in three places:
//   • the browser  (CSV/statement import in Me -> Billing)
//   • Node          (tests/deposit_parser.test.js)
//   • Deno          (supabase/functions/deposit-inbox, inlined by
//                   tools/build_deposit_inbox.js)
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THAT MATTERS MOST: never book an outgoing payment as income.
//
// Banks use nearly identical wording for both directions -- "You sent $50.00 to
// JOHN SMITH" and "You received $50.00 from JOHN SMITH" differ by two words. A
// parser that gets this wrong silently credits a family for money the CAMP paid
// out. So direction is decided FIRST, by an explicit deny-list checked before
// any amount is even looked at, and anything that isn't provably inbound is
// rejected rather than guessed at. A missed deposit is a phone call; a phantom
// credit is a family that stops paying tuition.
// ─────────────────────────────────────────────────────────────────────────────
//
// There are NO per-bank parsing rules. One ordered, bank-agnostic pattern
// list runs on every message (see PAYER_RES); the bank name is only a label.
// Adding support for a bank means adding a real fixture to the test corpus,
// not a rule -- and usually finding nothing needs changing at all.
//
// Exposed as window.CampistryDepositParser (browser) and module.exports (Node).
// =============================================================================
(function () {
    'use strict';

    var P = {};

    // ── direction gate ───────────────────────────────────────────────────────
    // Checked before anything else. If a message matches OUTBOUND it is thrown
    // away even when it also looks inbound, because the failure mode of a false
    // positive is money invented out of nothing.

    var OUTBOUND_RE = new RegExp([
        'you\\s+sent',
        'you\\s+paid',
        'payment\\s+(?:to|sent)',
        'sent\\s+(?:a\\s+)?payment',
        'your\\s+(?:zelle\\s+)?payment\\s+to',
        'withdrawal',
        'debit(?:ed)?\\s+(?:from|to)',
        'was\\s+debited',
        'transfer\\s+to',
        'has\\s+been\\s+sent',
        // Admitted by the widened INBOUND list above and genuinely outbound:
        // "a payment from your checking account to ACME" is money leaving.
        'from\\s+your\\s+(?:account|checking|savings|card)\\b[^\\n]{0,40}\\bto\\b',
        'you\\s+(?:have\\s+)?authorized'
    ].join('|'), 'i');

    // Widened from a real corpus. Every phrasing below was a message that this
    // gate REJECTED as "not a deposit" -- Navy Federal's "were credited",
    // Schwab's "Credit:", Amex's "has paid you". A rejection here is the worst
    // outcome in the whole pipeline: the money is real, and nothing is stored,
    // logged durably, or shown to anyone. Banks agree on far less wording than
    // you would hope, so this list is generous -- and safe to be, because
    // OUTBOUND_RE is checked FIRST and wins every tie.
    var INBOUND_RE = new RegExp([
        'you\\s+(?:have\\s+)?received',
        'sent\\s+you',
        'you\\s+got',
        'paid\\s+you',
        'deposit(?:ed)?\\b',
        'credit(?:ed)?\\s+(?:to|into)\\s+your',
        '(?:was|were|been)\\s+credited',
        '^\\s*credit\\s*[:\\-]',
        'amount\\s+credited',
        'received\\s+from',
        '\\bremitter\\b',
        '(?:payment|transfer|funds|money)\\s+from',
        'incoming\\s+(?:transfer|payment|wire|ach)',
        'money\\s+(?:has\\s+)?arrived'
    ].join('|'), 'im');

    // Alerts that are ABOUT a payment without being one: requests, reminders,
    // failures, reversals-in-progress. Booking any of these as cash means the
    // ledger says paid when nothing settled.
    var NON_EVENT_RE = new RegExp([
        'request(?:ed|s|ing)?\\s+(?:money|\\$|payment)',
        'is\\s+requesting',
        'reminder',
        'did\\s+not\\s+go\\s+through',
        'was\\s+(?:declined|cancell?ed|returned|reversed)',
        'unable\\s+to\\s+(?:process|complete)',
        'failed',
        'expired',
        'pending\\s+your\\s+approval',
        'enroll(?:ed|ment)?\\s+(?:in|with)\\s+zelle',
        'set\\s+up\\s+zelle'
    ].join('|'), 'i');

    /**
     * 'in' | 'out' | 'none'. Exported because the edge function logs the reason
     * a message was dropped -- a silent drop on a money path is undebuggable.
     */
    /**
     * 'in' | 'out' | 'non_event' | 'unclear'.
     *
     * 'non_event' and 'unclear' both mean "do not book this", but they are NOT
     * the same and must not be collapsed:
     *
     *   non_event  a request, a decline, a reminder, an enrolment notice. We
     *              recognised it and it is definitely not money arriving.
     *              Discarding it is correct and silent.
     *   unclear    no direction wording we recognise, either way. On a bank we
     *              have never seen that is indistinguishable from a real
     *              deposit, so it must NOT be discarded silently -- the caller
     *              keeps it for a human when it carries an amount.
     *
     * The old code returned 'none' for both, which is why an unrecognised
     * bank's deposit disappeared with nothing stored anywhere.
     */
    P.direction = function (text) {
        var s = String(text || '');
        if (!s.trim()) return 'unclear';
        if (NON_EVENT_RE.test(s)) return 'non_event';
        if (OUTBOUND_RE.test(s)) return 'out';
        if (INBOUND_RE.test(s)) return 'in';
        return 'unclear';
    };

    // ── text prep ────────────────────────────────────────────────────────────

    /** Bank alerts are almost always HTML. Flatten to text without a DOM. */
    P.htmlToText = function (html) {
        return String(html || '')
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|tr|td|th|li|h[1-6]|table)>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&#39;|&apos;/gi, "'")
            .replace(/&quot;/gi, '"')
            .replace(/[ \t ]+/g, ' ')
            .replace(/\n\s*\n\s*\n+/g, '\n\n')
            .trim();
    };

    // ── amount ───────────────────────────────────────────────────────────────

    var AMOUNT_RE = /\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)/g;

    P.parseAmount = function (raw) {
        if (raw == null) return null;
        var s = String(raw).replace(/[$,\s]/g, '');
        if (!/^-?[0-9]+(\.[0-9]+)?$/.test(s)) return null;
        var n = parseFloat(s);
        return isFinite(n) ? Math.round(Math.abs(n) * 100) / 100 : null;
    };

    /**
     * The deposit amount out of a whole email.
     *
     * Alert emails carry several dollar figures -- the payment, the resulting
     * balance, sometimes a daily limit or a fee. Taking the largest would grab
     * the balance; taking the last would grab the footer. So prefer a figure
     * that sits next to inbound wording, and only fall back to "first seen"
     * when no such anchor exists.
     */
    P.parseAmountFromText = function (text) {
        var s = String(text || '');
        var anchored = [
            /(?:you\s+(?:have\s+)?received|sent\s+you|deposit\s+of|credited\s+with|amount\s*[:\-]?)\s*(?:a\s+payment\s+of\s*)?\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)/i,
            /\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)\s*(?:was\s+)?(?:deposited|received|credited)/i
        ];
        for (var i = 0; i < anchored.length; i++) {
            var m = s.match(anchored[i]);
            if (m) {
                var v = P.parseAmount(m[1]);
                if (v) return v;
            }
        }
        // Fallback: first dollar figure that isn't obviously a balance.
        AMOUNT_RE.lastIndex = 0;
        var hit;
        while ((hit = AMOUNT_RE.exec(s)) !== null) {
            var before = s.slice(Math.max(0, hit.index - 40), hit.index);
            if (/balance|available|limit|fee\b/i.test(before)) continue;
            var val = P.parseAmount(hit[1]);
            if (val) return val;
        }
        return null;
    };

    // ── memo / reference code ────────────────────────────────────────────────
    //
    // The memo is the single most valuable field in the whole message: it is
    // the one piece a PARENT controls, so it survives every name mismatch a
    // business account or a maiden name creates. Whether a given bank forwards
    // the Zelle memo into the alert email varies, so we look for it in a memo
    // field AND scan the raw text for a bare code -- some banks drop the label
    // and leave the note inline.

    // Ordered: the labelled-field form is unambiguous, so it wins. Capital One
    // writes the Zelle memo as prose -- "Here's the message from YISRAEL
    // ROSENFELD: tst 1234" -- where the colon follows the PAYER, not the word
    // "message", so the generic `message:` rule never fires on it.
    var MEMO_RES = [
        /\b(?:memo|note|message|comment|description|for)\s*[:\-]\s*["']?([^\n"'<]{1,120})/i,
        /here'?s\s+the\s+message\s+from\s+[^\n:]{2,80}\s*:\s*([^\n]{1,120})/i,
        /\bmessage\s+from\s+[^\n:]{2,80}\s*:\s*([^\n]{1,120})/i
    ];

    /** A Campistry family memo code: three letters, a dash, four digits. */
    P.MEMO_CODE_RE = /\b([A-Za-z]{3})[-\s]?([0-9]{4})\b/;

    P.parseMemo = function (text) {
        var s = String(text || '');
        for (var i = 0; i < MEMO_RES.length; i++) {
            var m = s.match(MEMO_RES[i]);
            if (m && m[1]) {
                var memo = m[1].trim().replace(/\s+/g, ' ');
                if (memo && !/^https?:/i.test(memo)) return memo;
            }
        }
        return '';
    };

    /**
     * The family code out of anywhere in the message, normalized to `ABC-1234`.
     * Deliberately searched across the FULL text, not just the memo field.
     */
    P.parseMemoCode = function (text) {
        var m = String(text || '').match(P.MEMO_CODE_RE);
        return m ? (m[1].toUpperCase() + '-' + m[2]) : '';
    };

    // ── payer name ───────────────────────────────────────────────────────────

    // Trailing noise banks append after the name.
    // ── forwarded-mail headers ───────────────────────────────────────────────
    //
    // Forwarding is a first-class setup path: a camp that already gets alerts
    // in an existing mailbox is told to forward them here rather than re-do
    // their bank alert settings. Every mail client wraps the original in a
    // header block when it does that:
    //
    //     ---------- Forwarded message ---------
    //     From: Chase <no.reply.alerts@chase.com>
    //     Date: Tue, Jul 8, 2026
    //     To: office@camp.org
    //
    // The generic `from:` payer rule reads that `From:` line and books the
    // BANK as the payer on every forwarded alert -- worse than no name, since
    // a wrong name is what the matcher then scores against. So the envelope
    // headers are removed before any payer rule runs.
    //
    // Subject: is deliberately kept (as a bare line): banks put the amount and
    // often the payer in it, and it is the original subject, not the "Fwd:"
    // one. Only the addressing headers go.
    var FWD_MARKER_RE = /^\s*(?:-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:|-{2,}\s*original message\s*-{2,}|_{5,})\s*$/i;
    var FWD_HEADER_RE = /^\s*(?:from|to|cc|bcc|sent|date|reply-to|return-path|envelope-to)\s*:/i;

    P.stripForwardHeaders = function (text) {
        var lines = String(text || '').split('\n');
        var out = [];
        var inBlock = false;
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            if (FWD_MARKER_RE.test(ln)) { inBlock = true; continue; }
            if (inBlock) {
                if (FWD_HEADER_RE.test(ln)) continue;
                // Keep the original subject's text, minus the label.
                if (/^\s*subject\s*:/i.test(ln)) {
                    out.push(ln.replace(/^\s*subject\s*:\s*/i, ''));
                    continue;
                }
                // A blank line ends the header block; anything else means the
                // block was shorter than expected and the body has started.
                if (!ln.trim()) { inBlock = false; continue; }
                inBlock = false;
            }
            // Outside a marked block, a From:/To: line carrying an actual
            // address is still a header, not bank copy -- some clients forward
            // without a marker at all. A bank body line like "From: JOHN SMITH"
            // has no address in it and is kept.
            if (FWD_HEADER_RE.test(ln) && /\S+@\S+/.test(ln)) continue;
            out.push(ln);
        }
        return out.join('\n').trim();
    };

    // Everything a bank appends after the name. Each entry below came from a
    // real miss in the corpus: "GOLDSTEIN DENTAL PC was posted", "RACHEL FEIN
    // of $180.00 was received", "ARYEH LANDAU has been credited". A trailing
    // clause is not fatal on its own, but it changes the string the matcher
    // scores and defeats an exact alias hit, so it has to go.
    var NAME_TAIL_RE = new RegExp(
        '\\s+(?:' + [
            'sent', 'has\\s+sent', 'paid', 'via', 'with', 'using', 'on', 'to',
            'for', 'through', 'and',
            'was', 'were', 'has', 'have', 'had', 'is', 'are', 'will',
            'in\\s+the\\s+amount', 'of\\s+\\$', 'amount', 'ref', 'reference',
            'conf(?:irmation)?', 'trace', 'account', 'ending'
        ].join('|') + ')\\b[\\s\\S]*$', 'i');

    // "TD Bank: MIRIAM COHEN sent you $150.00" -- the bank labels its own line,
    // and the label rides along on the capture. A real payer name never
    // contains a colon, so a short leading "Label:" is always noise.
    var NAME_LEAD_RE = /^[A-Za-z][A-Za-z .&'-]{0,24}:\s*/;

    P.cleanName = function (raw) {
        var s = String(raw || '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^["'(\[]+|["')\]]+$/g, '')
            .replace(NAME_LEAD_RE, '')
            .replace(NAME_TAIL_RE, '')
            .replace(/[.,;:]+$/, '')
            .trim();
        // An email address is never a payer name. It reaches here from a mail
        // header a forwarding rule dragged in -- `Chase <no.reply@chase.com>`
        // -- so keep the display name and drop the address. A bare address
        // with no display name leaves nothing, which is the right answer:
        // better an unnamed deposit a human names than the bank booked as the
        // payer.
        if (s.indexOf('@') >= 0) {
            s = s.replace(/<[^>]*@[^>]*>?/g, ' ')
                 .replace(/\S+@\S+/g, ' ')
                 .replace(/\s+/g, ' ')
                 .replace(/^["'<(\[]+|["'>)\]]+$/g, '')
                 .trim();
        }
        // A bank that hides the name gives us asterisks -- that is not a name.
        if (!s || /^\*+$/.test(s)) return '';
        // Nor is marketing copy. Capital One's headline is "Good news: Someone
        // sent you money with Zelle" -- a payer rule that reaches it captures
        // the word "Someone", which would then be matched against families.
        if (/^(?:someone|a\s+friend|a\s+customer|sender|unknown|name\s+withheld)$/i.test(s)) return '';
        if (s.length > 80) s = s.slice(0, 80).trim();
        return s;
    };

    // ── payer name: bank-agnostic, ordered by specificity ────────────────────
    //
    // WHY THERE ARE NO PER-BANK RULES HERE ANY MORE.
    //
    // This used to be a list of rules each gated by `test: /chase/i`,
    // `/capital\s*one/i` and so on, with one loose GENERIC rule at the end for
    // everything else. That is backwards: coverage was WEAKEST for the banks
    // we had never seen, which is every bank a new camp brings. Worse, the gate
    // could fail on a bank we HAD written a rule for -- Capital One puts its
    // name only in the logo image, so "Capital One" never survives
    // htmlToText and its rule could not fire even in principle.
    //
    // Banks differ in wording, not in grammar. There are only so many ways to
    // say that money arrived, and they are all some arrangement of a name, a
    // verb, and a direction word. So: ONE ordered list, applied to EVERY email
    // regardless of sender, most specific first. A bank we have never seen gets
    // exactly the same treatment as one we have.
    //
    // `bank` is now only a LABEL for the office to read, never a gate.
    //
    // Ordering rule: a pattern that anchors on an amount or a colon is more
    // specific than a bare "from X", so it goes first. The loosest patterns
    // must stay last or they will strip a name off marketing copy.
    var PAYER_RES = [
        // "Here's the message from JOHN SMITH: <memo>" -- names the payer with
        // no marketing copy nearby, so it is the most reliable form there is.
        /(?:here'?s\s+the\s+)?message\s+from\s+([^\n:]{2,80}?)\s*:/i,

        // "You received $50.00 from JOHN SMITH" and its many rewordings.
        /you(?:'ve|\s+have)?\s+(?:just\s+)?(?:received|got)\s+\$?[0-9,.]*\s*(?:money\s+|a\s+payment\s+)?from\s+((?:[^\n.]|\.(?=\S)){2,80})/i,

        // "JOHN SMITH has just sent you money ... $50.00" (Capital One's shape).
        // The '$' on the same line is load-bearing: it excludes the headline
        // "Good news: Someone sent you money with Zelle", which carries no
        // amount and would otherwise yield the payer "Someone".
        /^\s*([^\n]{2,80}?)\s+(?:has\s+|had\s+)?(?:just\s+)?sent\s+you\s+money\b[^\n]*\$/im,
        /^\s*([^\n]{2,80}?)\s+(?:has\s+|had\s+)?(?:just\s+)?sent\s+you\s+\$/im,
        /^\s*([^\n]{2,80}?)\s+(?:has\s+|had\s+)?(?:just\s+)?paid\s+you\b[^\n]*\$/im,

        // Labelled fields, as used by statement-style and business alerts.
        /(?:sender|payer|originator|received\s+from|paid\s+by|remitter)\s*[:\-]\s*((?:[^\n.]|\.(?=\S)){2,80})/i,

        // "payment/deposit/transfer/credit from JOHN SMITH"
        /(?:payment|deposit|transfer|credit|funds|money)\s+(?:of\s+\$?[0-9,.]+\s+)?from\s+((?:[^\n.]|\.(?=\S)){2,80})/i,

        // "received ... from X" / "deposited ... from X" in any other phrasing.
        /(?:received|deposit(?:ed)?|credited)\b[^\n]{0,40}?\s+from\s+((?:[^\n.]|\.(?=\S)){2,80})/i,

        // Loosest: a bare labelled "From: X". Kept last, and stripForwardHeaders
        // has already removed the mail headers that would otherwise match it.
        /\bfrom\s*[:\-]\s*((?:[^\n.]|\.(?=\S)){2,80})/i
    ];

    // The payer capture is `(?:[^\n.]|\.(?=\S)){2,80}` throughout: any character
    // except a newline, plus a period ONLY when the next character is not a
    // space. That keeps a period that lives inside a token ("ABC CO.LTD") while
    // still stopping dead at a sentence end -- "from JOHN SMITH. View your
    // account online" must yield "JOHN SMITH", never the sentence after it,
    // because a wrong name is what the matcher scores against.

    // Bank label only -- never gates which patterns run. Purely so the office
    // can see at a glance where a deposit came from.
    var BANK_LABELS = [
        ['chase',       /\bchase\b/i],
        ['bofa',        /bank\s*of\s*america|\bbofa\b/i],
        ['wellsfargo',  /wells\s*fargo/i],
        ['citi',        /\bciti(?:bank)?\b/i],
        ['capitalone',  /capital\s*one/i],
        ['usbank',      /\bu\.?s\.?\s*bank\b/i],
        ['pnc',         /\bpnc\b/i],
        ['truist',      /\btruist\b/i],
        ['tdbank',      /\btd\s*bank\b/i],
        ['amex',        /american\s*express|\bamex\b/i],
        ['ally',        /\bally\s*bank\b/i],
        ['discover',    /\bdiscover\s*bank\b/i],
        ['schwab',      /\bschwab\b/i],
        ['navyfederal', /navy\s*federal/i],
        ['zelle',       /\bzelle\b/i]
    ];

    P.detectBank = function (text) {
        var s = String(text || '');
        for (var i = 0; i < BANK_LABELS.length; i++) {
            if (BANK_LABELS[i][1].test(s)) return BANK_LABELS[i][0];
        }
        return '';
    };

    /**
     * The payer name, or '' when nothing trustworthy is found.
     *
     * '' is a legitimate, common answer and never an error: the deposit is
     * still recorded, and lands in the inbox for a human to name. Guessing
     * would be worse -- a wrong name is what the matcher scores against.
     */
    P.parsePayer = function (text) {
        var s = String(text || '');
        for (var i = 0; i < PAYER_RES.length; i++) {
            var hit = s.match(PAYER_RES[i]);
            if (!hit || !hit[1]) continue;
            var nm = P.cleanName(hit[1]);
            if (nm && P.looksLikeName(nm)) return nm;
        }
        return '';
    };

    // Words that mean the capture ran into boilerplate rather than a name. A
    // loose pattern on an unknown bank's wording WILL sometimes grab a clause;
    // this is what stops that clause reaching the matcher.
    var NOT_NAME_RE = new RegExp([
        '\\bzelle\\b', '\\bwww\\.', 'http', '\\baccount\\b', '\\bbalance\\b',
        '\\bavailable\\b', '\\bsign\\s*in\\b', '\\block\\b', '\\bfraud\\b',
        '\\bcustomer\\s*service\\b', '\\bdo\\s*not\\s*reply\\b', '\\bclick\\b',
        '\\bunsubscribe\\b', '\\bmember\\s*fdic\\b', '\\bterms\\b', '\\bprivacy\\b',
        '\\byour\\s+(?:account|bank|card)\\b', '\\bending\\s+in\\b'
    ].join('|'), 'i');

    /**
     * A sanity gate on a candidate payer name.
     *
     * The point of the loose patterns above is coverage on banks we have never
     * seen; the cost is that they sometimes capture a fragment of a sentence.
     * A name has a shape -- a few words, mostly letters, no URLs, no banking
     * vocabulary -- and anything that fails it is dropped rather than passed to
     * the matcher. Dropping costs a human ten seconds; a wrong name pointed at
     * the wrong family costs a family's trust.
     */
    P.looksLikeName = function (s) {
        var v = String(s || '').trim();
        if (v.length < 2 || v.length > 80) return false;
        if (NOT_NAME_RE.test(v)) return false;
        if (!/[A-Za-z]{2}/.test(v)) return false;           // must have letters
        if (/^[0-9\W]+$/.test(v)) return false;             // digits/punctuation only
        var words = v.split(/\s+/);
        if (words.length > 6) return false;                 // a clause, not a name
        // Mostly letters. A business name carries &, ., -, ' and digits, but a
        // capture that is half punctuation is boilerplate.
        var letters = (v.match(/[A-Za-z]/g) || []).length;
        return letters >= Math.ceil(v.replace(/\s/g, '').length * 0.5);
    };

    // ── ACH statement descriptors ────────────────────────────────────────────
    //
    // NACHA-shaped descriptors are far more regular than marketing email and
    // are what the aggregator feed and every CSV export actually contain.

    var DESCRIPTOR_RULES = [
        { kind: 'ach',   re: /ORIG\s*CO\s*NAME\s*[:\-]?\s*([^\n]{2,60}?)(?:\s+ORIG\s*ID|\s+DESC\s*DATE|\s+ENTRY|\s+TRACE|$)/i },
        { kind: 'zelle', re: /ZELLE\s*(?:FROM|PAYMENT\s*FROM|INSTANT\s*PMT\s*FROM)\s*[:\-]?\s*([^\n]{2,60}?)(?:\s+(?:ON|CONF|REF|JPM|WEB|ID)\b|\s{2,}|$)/i },
        { kind: 'ach',   re: /(?:ACH|DIRECT)\s*(?:CREDIT|DEP(?:OSIT)?)\s*[:\-]?\s*(?:FROM\s+)?([^\n]{2,60}?)(?:\s+(?:REF|TRACE|ID)\b|\s{2,}|$)/i },
        { kind: 'wire',  re: /(?:INCOMING\s*)?WIRE\s*(?:TRANSFER\s*)?(?:FROM|CREDIT)\s*[:\-]?\s*([^\n]{2,60}?)(?:\s+(?:REF|IMAD|OMAD)\b|\s{2,}|$)/i },
        { kind: 'ach',   re: /(?:DEPOSIT|CREDIT)\s+FROM\s+([^\n]{2,60}?)(?:\s+(?:REF|TRACE|ID)\b|\s{2,}|$)/i }
    ];

    // Ordered strongest-first. A NACHA descriptor carries BOTH "ORIG ID:" (the
    // originating company's permanent id, identical on every payment they ever
    // send) and "TRACE#:" (unique to this one transaction). Grabbing ORIG ID
    // would give every payment from the same company the same trace, which
    // collapses distinct deposits into one fingerprint and silently drops
    // money. So the specific labels are tried first, and the loose bare-`ID`
    // fallback only runs after ORIG ID has been cut out of the string.
    var TRACE_RES = [
        /TRACE\s*#?\s*[:\-]?\s*([A-Z0-9]{6,25})\b/i,
        /CONF(?:IRMATION)?\s*(?:#|NO\.?|NUM(?:BER)?)?\s*[:\-]?\s*([A-Z0-9]{6,25})\b/i,
        /\bREF(?:ERENCE)?\s*#?\s*[:\-]?\s*([A-Z0-9]{6,25})\b/i
    ];
    var ORIG_ID_RE = /\bORIG\s*ID\s*[:\-]?\s*[A-Z0-9]+/ig;

    function findTrace(s) {
        for (var i = 0; i < TRACE_RES.length; i++) {
            var m = s.match(TRACE_RES[i]);
            if (m) return m[1];
        }
        var stripped = s.replace(ORIG_ID_RE, ' ');
        var bare = stripped.match(/\bID\s*[:\-]\s*([A-Z0-9]{6,25})\b/i);
        return bare ? bare[1] : '';
    }

    /**
     * Parse a raw bank/statement descriptor. Used by CSV import and by the
     * aggregator feed, and also as a fallback inside email parsing when the
     * bank pastes the descriptor into the alert body.
     */
    P.parseDescriptor = function (raw) {
        var s = String(raw || '').replace(/\s+/g, ' ').trim();
        if (!s) return { payerName: '', kind: '', traceId: '' };
        for (var i = 0; i < DESCRIPTOR_RULES.length; i++) {
            var m = s.match(DESCRIPTOR_RULES[i].re);
            if (m && m[1]) {
                var nm = P.cleanName(m[1]);
                if (nm) {
                    return {
                        payerName: nm,
                        kind: DESCRIPTOR_RULES[i].kind,
                        traceId: findTrace(s)
                    };
                }
            }
        }
        return { payerName: '', kind: /zelle/i.test(s) ? 'zelle' : '', traceId: '' };
    };

    // ── kind + date ──────────────────────────────────────────────────────────

    P.detectKind = function (text) {
        var s = String(text || '');
        if (/zelle/i.test(s)) return 'zelle';
        if (/\bwire\b/i.test(s)) return 'wire';
        if (/\bach\b|direct\s*dep|orig\s*co\s*name|e-?check/i.test(s)) return 'ach';
        return 'ach';
    };

    var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

    function iso(y, m, d) {
        if (!y || !m || !d) return '';
        if (y < 100) y += 2000;
        if (m < 1 || m > 12 || d < 1 || d > 31) return '';
        return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }

    /** A YYYY-MM-DD date out of free text. Returns '' rather than guessing. */
    P.parseDate = function (text) {
        var s = String(text || '');
        var m = s.match(/\b(20[0-9]{2})-([0-9]{1,2})-([0-9]{1,2})\b/);
        if (m) return iso(+m[1], +m[2], +m[3]);
        m = s.match(/\b([0-9]{1,2})\/([0-9]{1,2})\/(20[0-9]{2}|[0-9]{2})\b/);
        if (m) return iso(+m[3], +m[1], +m[2]);   // US order; bank alerts are US-only
        m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+([0-9]{1,2}),?\s+(20[0-9]{2})\b/i);
        if (m) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
        return '';
    };

    // ── dedupe fingerprint ───────────────────────────────────────────────────
    //
    // The same deposit can legitimately arrive twice: once from the alert email
    // and again from the bank feed, or from two overlapping CSV exports. All of
    // them must collapse onto one row, so the fingerprint deliberately EXCLUDES
    // the source -- it identifies the money, not the message.
    //
    // FNV-1a: tiny, dependency-free, and identical in every runtime. This is a
    // dedupe key, never a security boundary.

    P.normalizeForKey = function (s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    };

    P.fingerprint = function (dep) {
        var d = dep || {};
        var basis = [
            d.date || '',
            (P.parseAmount(d.amount) || 0).toFixed(2),
            P.normalizeForKey(d.payerName),
            P.normalizeForKey(d.traceId)
        ].join('|');
        var h = 0x811c9dc5;
        for (var i = 0; i < basis.length; i++) {
            h ^= basis.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return 'dep_' + ('00000000' + h.toString(16)).slice(-8) + '_' +
               ('00000000' + basis.length.toString(16)).slice(-4);
    };

    // ── the entry point ──────────────────────────────────────────────────────

    /**
     * Parse a bank alert email into a deposit.
     *
     * Returns { ok:false, reason } rather than throwing -- the caller is a
     * webhook that must always answer 200 (a retried inbound email is a
     * duplicate deposit), and it logs the reason.
     */
    P.parseEmail = function (msg) {
        var m = msg || {};
        var subject = String(m.subject || '');
        var body = m.text ? String(m.text) : P.htmlToText(m.html || '');
        var full = P.stripForwardHeaders((subject + '\n' + body).trim());

        if (!full) return { ok: false, reason: 'empty_message' };

        // `amount` is reported even on failure. A message we could not classify
        // but which mentions money is the signature of a bank we have never
        // seen, and the caller keeps those rather than dropping them.
        var amount = P.parseAmountFromText(full);

        var dir = P.direction(full);
        if (dir === 'out')       return { ok: false, reason: 'outbound_payment', amount: amount };
        if (dir === 'non_event') return { ok: false, reason: 'non_event', amount: amount };
        if (dir === 'unclear')   return { ok: false, reason: 'unclear_direction', amount: amount };

        if (!amount) return { ok: false, reason: 'no_amount', amount: null };

        // Bank rules first; the descriptor parser is the fallback for alerts
        // that simply paste the statement line into the body.
        // One ordered pattern list, applied whatever the sender: see PAYER_RES.
        var payerName = P.parsePayer(full);
        var bank = P.detectBank(full);

        // A statement descriptor pasted into the alert body is far more regular
        // than the prose around it, so it is a genuine second opinion rather
        // than a fallback of last resort.
        var desc = P.parseDescriptor(full);
        if (!payerName && desc.payerName) { payerName = desc.payerName; bank = bank || 'descriptor'; }

        // No payer name is still a real deposit -- it lands in the inbox for a
        // human instead of being thrown away. Money must never be dropped just
        // because we could not read who sent it.
        var memo = P.parseMemo(full);
        return {
            ok: true,
            deposit: {
                amount: amount,
                payerName: payerName,
                memo: memo,
                memoCode: P.parseMemoCode(memo) || P.parseMemoCode(full),
                date: P.parseDate(full) || String(m.receivedAt || '').slice(0, 10) || '',
                kind: desc.kind || P.detectKind(full),
                traceId: desc.traceId || '',
                bank: bank,
                source: 'email',
                rawSubject: subject.slice(0, 200)
            }
        };
    };

    /**
     * Parse one row of a bank CSV / aggregator feed. Credits only -- a debit
     * row is dropped for the same reason an outbound email is.
     */
    P.parseFeedRow = function (row) {
        var r = row || {};
        var amount = P.parseAmount(r.amount);
        if (!amount) return { ok: false, reason: 'no_amount' };
        // An explicit direction wins; otherwise a negative amount means debit.
        var dirField = String(r.direction || r.type || '').toLowerCase();
        if (/debit|withdraw|out/.test(dirField)) return { ok: false, reason: 'debit_row' };
        if (!/credit|deposit|in\b/.test(dirField) && Number(r.amount) < 0) {
            return { ok: false, reason: 'debit_row' };
        }
        var descriptor = String(r.description || r.descriptor || r.memo || '');
        var desc = P.parseDescriptor(descriptor);
        return {
            ok: true,
            deposit: {
                amount: amount,
                payerName: desc.payerName,
                memo: descriptor,
                memoCode: P.parseMemoCode(descriptor),
                date: P.parseDate(String(r.date || '')) || String(r.date || '').slice(0, 10),
                kind: desc.kind || P.detectKind(descriptor),
                traceId: desc.traceId || String(r.traceId || ''),
                bank: String(r.bank || ''),
                source: String(r.source || 'feed'),
                rawSubject: descriptor.slice(0, 200)
            }
        };
    };

    // globalThis (not just window) so the exact same file runs unmodified in
    // Deno inside the deposit-inbox edge function -- see
    // tools/build_deposit_inbox.js, which inlines this file verbatim into the
    // single self-contained index.ts that gets deployed.
    if (typeof globalThis !== 'undefined') globalThis.CampistryDepositParser = P;
    if (typeof window !== 'undefined') window.CampistryDepositParser = P;
    if (typeof module !== 'undefined' && module.exports) module.exports = P;
})();

// ─── campistry_deposit_match.js ────────────────────────────────
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

// The two modules above register themselves on globalThis; bind them for the
// handler, which is written against these two names.
const Parser = globalThis.CampistryDepositParser;
const Matcher = globalThis.CampistryDepositMatch;

// ============================================================================
// deposit-inbox — turn a bank's deposit alert email into a tuition payment.
//
// Zelle has no merchant API and a plain ACH credit has no callback, so the
// fastest thing that can tell Campistry money arrived is the alert email the
// camp's own bank sends the moment it lands. The camp points that alert at
//
//     deposits+<inbound_token>@<the inbound domain>
//
// Resend receives it and POSTs an `email.received` webhook here. This function
// verifies it, parses it, decides which family it belongs to, and either posts
// it to that family's ledger or drops it in the reconcile inbox for a human.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS ENDPOINT CREATES MONEY. It is public (Resend is not a Supabase caller),
// so it is authenticated by THREE independent checks, all required:
//
//   1. Svix signature over the RAW body — proves Resend sent it.
//   2. The routing token in the To: address — proves which camp, and is a
//      per-camp secret that can be rotated without touching DNS.
//   3. The From: domain against the camp's allowlist — proves the camp's BANK
//      sent it, not somebody who learned the address.
//
// Anyone who can forge a deposit here can make a family's balance disappear.
// Never relax these to "make testing easier"; use a test camp instead.
// ─────────────────────────────────────────────────────────────────────────────
//
// Always answers 200 once the signature passes, including on parse failures.
// A non-2xx makes Resend redeliver, and a redelivered deposit is a duplicate
// deposit; the fingerprint would catch it, but a webhook that is loudly
// "failing" while behaving correctly wastes far more time than a logged skip.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_WEBHOOK_SECRET,
//      RESEND_API_KEY, (optional) RESEND_RECEIVING_URL
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS FILE IS NOT DEPLOYED DIRECTLY. It is the authored half of
// supabase/functions/deposit-inbox/index.ts, which tools/build_deposit_inbox.js
// generates by prepending the parser and matcher to it.
//
// Why: Supabase's Dashboard deploy flattens a function to source/index.ts, so a
// relative import of a sibling module ("../_shared/…") resolves outside the
// bundle and the deploy fails with "Module not found". Campistry deploys from
// the Dashboard (no CLI), so the deployable artifact has to be ONE file with no
// local imports. `Parser` and `Matcher` below are provided by the generator.
//
// Edit this file (or the two root modules), then run:
//     node tools/build_deposit_inbox.js
// ─────────────────────────────────────────────────────────────────────────────
// ============================================================================

// Supplied by tools/build_deposit_inbox.js, which inlines campistry_deposit_parser.js
// and campistry_deposit_match.js above this point and binds them off globalThis.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, svix-id, svix-timestamp, svix-signature",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── 1. Svix signature ────────────────────────────────────────────────────────
// Resend signs with the Standard Webhooks scheme: HMAC-SHA256 over
// `${svix-id}.${svix-timestamp}.${raw body}`, keyed by the base64 secret after
// the `whsec_` prefix. The signature header may carry several space-separated
// `v1,<sig>` values (during a secret rotation), so any one matching is a pass.
async function verifySvix(req: Request, rawBody: string): Promise<boolean> {
  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (!secret) {
    // Refuse rather than accept an unverifiable webhook — the same stance
    // telnyx-sms-webhook takes when TELNYX_PUBLIC_KEY is missing.
    console.error("[deposit-inbox] RESEND_WEBHOOK_SECRET is not set — refusing");
    return false;
  }
  const id = req.headers.get("svix-id");
  const ts = req.headers.get("svix-timestamp");
  const sigHeader = req.headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;

  // Replay window. Without this, a captured delivery can be replayed forever.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!isFinite(age) || age > 300) {
    console.warn("[deposit-inbox] timestamp outside the 5-minute window");
    return false;
  }

  try {
    const keyBytes = Uint8Array.from(
      atob(secret.replace(/^whsec_/, "")),
      (c) => c.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey(
      "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const signed = new TextEncoder().encode(`${id}.${ts}.${rawBody}`);
    const mac = await crypto.subtle.sign("HMAC", key, signed);
    const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

    return sigHeader.split(" ").some((part) => {
      const [version, value] = part.split(",");
      return version === "v1" && value === expected;
    });
  } catch (e) {
    console.error("[deposit-inbox] signature verify failed", (e as Error).message);
    return false;
  }
}

// ── 2. reading the webhook payload ───────────────────────────────────────────
// Resend's `email.received` payload carries METADATA ONLY — the body and any
// attachments are fetched separately (that is what lets it handle large mail in
// serverless environments). The exact field names are not fully documented
// publicly, so every lookup below accepts a few plausible spellings and the
// setup guide has a step for confirming the real shape against one live
// delivery. If a future payload includes the body inline, we use it and skip
// the extra fetch entirely.
function pick(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function addressesOf(v: unknown): string[] {
  // to/from arrive as a string, an array of strings, or objects with .address
  if (!v) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const a = o.address ?? o.email ?? o.value;
      if (typeof a === "string") return [a];
    }
    return [];
  });
}

/** `deposits+ab12cd@inbound.example.com` -> `ab12cd` */
function tokenFromAddresses(addrs: string[]): string {
  for (const a of addrs) {
    const m = String(a).toLowerCase().match(/\+([a-z0-9]{8,64})@/);
    if (m) return m[1];
  }
  // Also allow the whole local part to be the token (`ab12cd@...`), which is
  // what a Resend managed address looks like when there is no plus-addressing.
  for (const a of addrs) {
    const m = String(a).toLowerCase().match(/^([a-z0-9]{16,64})@/);
    if (m) return m[1];
  }
  return "";
}

function domainOf(addr: string): string {
  const m = String(addr).toLowerCase().match(/@([^>\s]+)$/);
  return m ? m[1] : "";
}

/** Fetch the message body Resend held back from the webhook payload. */
async function fetchBody(emailId: string): Promise<{ text: string; html: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey || !emailId) return { text: "", html: "" };

  const base = Deno.env.get("RESEND_RECEIVING_URL") ||
    "https://api.resend.com/emails/receiving";
  try {
    const res = await fetch(`${base}/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.warn(`[deposit-inbox] body fetch ${res.status} for ${emailId}`);
      return { text: "", html: "" };
    }
    const body = await res.json();
    const d = (body?.data ?? body) as Record<string, unknown>;
    return { text: pick(d, "text", "plain", "textBody"), html: pick(d, "html", "htmlBody") };
  } catch (e) {
    console.error("[deposit-inbox] body fetch failed", (e as Error).message);
    return { text: "", html: "" };
  }
}

// ── 3. matching context ──────────────────────────────────────────────────────
// Families come from the campistryMe blob (read-only — this function never
// writes to camp_state_kv; see migration 145's header for why). Balances come
// from the snapshot the browser publishes, because buildFamilyLedgers() cannot
// run here. A missing snapshot just means the overpay guardrail sits out.
async function loadContext(service: ReturnType<typeof createClient>, campId: string) {
  const [kv, aliasRes, balRes] = await Promise.all([
    service.from("camp_state_kv").select("value")
      .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle(),
    service.from("payer_aliases")
      .select("family_key, normalized, handle, display_name, kind").eq("camp_id", campId),
    service.from("family_balance_snapshots")
      .select("family_key, balance_cents").eq("camp_id", campId),
  ]);

  const families = (kv.data?.value as Record<string, unknown>)?.families ?? {};

  const aliases = (aliasRes.data ?? []).map((a: Record<string, unknown>) => ({
    familyKey: a.family_key,
    normalized: a.normalized,
    handle: a.handle,
    displayName: a.display_name,
    kind: a.kind,
  }));

  const ledgers: Record<string, { balance: number }> = {};
  for (const b of balRes.data ?? []) {
    ledgers[(b as Record<string, unknown>).family_key as string] = {
      balance: ((b as Record<string, unknown>).balance_cents as number) / 100,
    };
  }

  return { families, aliases, ledgers };
}

// ── handler ──────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const rawBody = await req.text();

  // Check 1 of 3 — and the only one that returns non-200, because an unsigned
  // request is not a delivery worth acknowledging.
  if (!(await verifySvix(req, rawBody))) {
    return json({ error: "invalid_signature" }, 401);
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ ok: true, skipped: "unparseable_body" });
  }

  const type = String(event.type ?? "");
  if (type && type !== "email.received") {
    return json({ ok: true, skipped: `ignored_event:${type}` });
  }

  const data = (event.data ?? event) as Record<string, unknown>;
  const toAddrs = [...addressesOf(data.to), ...addressesOf(data.recipient), ...addressesOf(data.envelope_to)];
  const fromAddrs = [...addressesOf(data.from), ...addressesOf(data.sender)];
  const subject = pick(data, "subject");
  const emailId = pick(data, "email_id", "emailId", "id");

  // Check 2 of 3 — which camp is this for?
  const token = tokenFromAddresses(toAddrs);
  if (!token) {
    console.warn("[deposit-inbox] no routing token in", JSON.stringify(toAddrs));
    return json({ ok: true, skipped: "no_routing_token" });
  }

  const service = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: camp, error: campErr } = await service.rpc("_deposit_camp_for_token", {
    p_token: token,
  });
  if (campErr || !camp?.success) {
    console.warn("[deposit-inbox] unknown or disabled token");
    return json({ ok: true, skipped: "unknown_token" });
  }
  const campId = camp.campId as string;

  // Check 3 of 3 — did the camp's actual bank send this?
  const allowlist: string[] = (camp.senderAllowlist ?? []).map((s: string) => s.toLowerCase());
  if (allowlist.length) {
    const senderDomains = fromAddrs.map(domainOf).filter(Boolean);
    const ok = senderDomains.some((d) =>
      allowlist.some((allowed) => d === allowed || d.endsWith(`.${allowed}`))
    );
    if (!ok) {
      console.warn(`[deposit-inbox] sender ${senderDomains.join(",")} not allowed for camp ${campId}`);
      return json({ ok: true, skipped: "sender_not_allowed" });
    }
  }

  // Body: inline if the payload ever carries it, otherwise fetched.
  let text = pick(data, "text", "plain");
  let html = pick(data, "html");
  if (!text && !html) {
    const fetched = await fetchBody(emailId);
    text = fetched.text;
    html = fetched.html;
  }

  const parsed = Parser.parseEmail({
    subject,
    text,
    html,
    receivedAt: pick(data, "created_at", "createdAt", "received_at") || new Date().toISOString(),
  });

  if (!parsed.ok) {
    // Two very different failures hide behind "could not parse", and treating
    // them the same is how money goes missing.
    //
    //  * outbound_payment / non_event / no_amount -- we RECOGNISED the message
    //    and it is not income: a payment we sent, a money request, a decline,
    //    a marketing blast. Dropping these is correct; most mail reaching this
    //    address is exactly this, and storing it would bury the real items.
    //
    //  * unclear_direction WITH an amount -- we recognised nothing at all, yet
    //    the message talks about money. On a bank whose wording we have never
    //    seen, that is indistinguishable from a genuine deposit. This used to
    //    be dropped too, which meant a real deposit from an unfamiliar bank
    //    vanished leaving only a log line that ages out in days, and nobody
    //    found out until a family said they had paid.
    //
    // So the ambiguous ones are recorded as 'unparsed': never counted in any
    // balance, always visible in the inbox, with the message text attached so
    // the office can read what actually arrived and fix it by hand.
    const keepForHuman = parsed.reason === "unclear_direction" && !!parsed.amount;
    if (!keepForHuman) {
      console.log(`[deposit-inbox] camp ${campId}: skipped (${parsed.reason}) "${subject}"`);
      return json({ ok: true, skipped: parsed.reason });
    }

    const bodyText = (text || Parser.htmlToText(html || "")).slice(0, 4000);
    const unparsed = await service.rpc("_deposit_record_unparsed", {
      p_camp_id: campId,
      // No parsed fields to fingerprint on, so the message itself is the
      // identity. That still collapses a Resend retry of the same email onto
      // one row, which is what this needs to do.
      p_fingerprint: "raw_" + Parser.fingerprint({
        date: pick(data, "created_at", "createdAt", "received_at").slice(0, 10),
        amount: parsed.amount || 0,
        payerName: subject,
        traceId: emailId || bodyText.slice(0, 120),
      }),
      p_raw_subject: subject,
      p_raw_excerpt: bodyText,
      p_reason: parsed.reason,
    });

    if (unparsed.error) {
      // Same reasoning as a failed record below: the money may be real and we
      // could not store it, so let Resend retry.
      console.error("[deposit-inbox] unparsed record failed", unparsed.error.message);
      return json({ error: "record_failed" }, 500);
    }

    console.log(
      `[deposit-inbox] camp ${campId}: UNPARSED ($${parsed.amount}) kept for review "${subject}"`,
    );
    return json({ ok: true, unparsed: true, duplicate: unparsed.data?.duplicate ?? false });
  }

  const deposit = parsed.deposit;
  // Kept on the row so a payer name read off unfamiliar prose can be checked
  // against what actually arrived. Without it, "is this name right?" has no
  // answer anyone can look up.
  deposit.rawExcerpt = (text || Parser.htmlToText(html || "")).slice(0, 4000);
  const ctx = await loadContext(service, campId);
  const decision = Matcher.decide(deposit, ctx, {
    autoPostAt: camp.autoPostAt,
    suggestAt: camp.suggestAt,
    ambiguousGap: camp.ambiguousGap,
    dryRun: camp.dryRun,
  });

  const record = await service.rpc("_deposit_record", {
    p_camp_id: campId,
    p_fingerprint: Parser.fingerprint(deposit),
    p_amount_cents: Math.round(deposit.amount * 100),
    p_deposit: deposit,
    p_decision: {
      decision: decision.decision,
      familyKey: decision.familyKey,
      confidence: decision.confidence,
      guardrail: decision.guardrail,
      candidates: decision.candidates,
      reasons: decision.candidates?.[0]?.reasons ?? [],
    },
  });

  if (record.error) {
    // The one case worth a 5xx: the money is real, we could not store it, and
    // a Resend retry is exactly what we want.
    console.error("[deposit-inbox] record failed", record.error.message);
    return json({ error: "record_failed" }, 500);
  }

  console.log(
    `[deposit-inbox] camp ${campId}: $${deposit.amount} from "${deposit.payerName}" ` +
    `-> ${record.data?.duplicate ? "duplicate" : decision.decision}` +
    (decision.guardrail ? ` (${decision.guardrail})` : ""),
  );

  return json({
    ok: true,
    duplicate: record.data?.duplicate ?? false,
    decision: decision.decision,
    confidence: decision.confidence,
  });
});

