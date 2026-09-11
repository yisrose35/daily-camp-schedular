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

    // ── returns / NSF ────────────────────────────────────────────────────────
    //
    // An ACH or Zelle credit that already landed can be pulled back days later:
    // insufficient funds, a closed account, a disputed transfer. The bank sends
    // a second email, and it is the single most consequential message in this
    // whole feature -- the family currently reads as PAID when the money is
    // gone. Until now "was returned" matched NON_EVENT_RE and the message was
    // discarded, so the original credit just stayed on the ledger.
    //
    // Two conditions, both required, because the word "returned" alone is far
    // too common: a return word AND something identifying the item as money
    // that came IN. "Your payment to Con Ed was returned" is our own outgoing
    // payment bouncing back and is deliberately NOT handled here -- it is a
    // credit, but an unpredictable one, and guessing at it would invent money.
    var RETURN_WORD_RE = new RegExp([
        '(?:was|has\\s+been|were|have\\s+been)\\s+(?:returned|reversed)',
        'return(?:ed)?\\s+(?:item|deposit|payment|transfer|ach|entry)',
        '\\breturned\\s+unpaid\\b',
        'reversal\\s+of',
        'insufficient\\s+funds',
        '\\bNSF\\b',
        'charge(?:d)?\\s*back',
        '\\bchargeback\\b'
    ].join('|'), 'i');

    var INCOMING_ITEM_RE = new RegExp([
        '\\bdeposit\\b', '\\bcredit(?:ed)?\\b', '\\breceived\\b',
        '\\bzelle\\b', '\\bach\\b', '\\bincoming\\b', '\\bfrom\\b'
    ].join('|'), 'i');

    // "Your payment to X was returned" -- our money coming back, not a family's
    // payment failing. Excluded so it is never booked as a family's debit.
    var OUR_PAYMENT_RETURN_RE = /\b(?:your|our)\s+payment\s+to\b|\bpayment\s+to\s+[^\n]{1,60}\s+(?:was|has\s+been)\s+(?:returned|reversed)/i;

    P.isReturn = function (text) {
        var s = String(text || '');
        if (!RETURN_WORD_RE.test(s)) return false;
        if (OUR_PAYMENT_RETURN_RE.test(s)) return false;
        return INCOMING_ITEM_RE.test(s);
    };

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
        // Before NON_EVENT: "was returned" appears in both, and a genuine
        // return of an incoming deposit must never be discarded as noise.
        if (P.isReturn(s)) return 'reversal';
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
            'conf(?:irmation)?', 'trace', 'account', 'ending',
            // Return notices append the reason to the payer's own line.
            'nsf', 'returned', 'reversed', 'due', 'insufficient', 'because'
        ].join('|') + ')\\b[\\s\\S]*$', 'i');

    // "TD Bank: MIRIAM COHEN sent you $150.00" -- the bank labels its own line,
    // and the label rides along on the capture. A real payer name never
    // contains a colon, so a short leading "Label:" is always noise.
    var NAME_LEAD_RE = /^[A-Za-z][A-Za-z .&'-]{0,24}:\s*/;

    // A SPACED dash always separates a name from a trailing clause -- "SARA
    // LEVI - NSF, returned unpaid". An unspaced one is part of the name and
    // must survive, so "SMITH-JONES" is untouched.
    var NAME_DASH_TAIL_RE = /\s+[\u2014\u2013-]\s+[\s\S]*$/;

    P.cleanName = function (raw) {
        var s = String(raw || '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^["'(\[]+|["')\]]+$/g, '')
            .replace(NAME_LEAD_RE, '')
            .replace(NAME_DASH_TAIL_RE, '')
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
            P.normalizeForKey(d.traceId),
            // Without this a same-day return of a deposit that carries no trace
            // number is identical to the deposit itself, and ON CONFLICT DO
            // NOTHING silently swallows it -- the family keeps a credit for
            // money the bank has already taken back. The one case where
            // collapsing two rows loses money rather than saving it.
            d.isReversal ? 'rev' : ''
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
        var isReversal = (dir === 'reversal');
        if (isReversal && !amount) return { ok: false, reason: 'return_no_amount', amount: null };
        if (dir === 'out')       return { ok: false, reason: 'outbound_payment', amount: amount };
        if (dir === 'non_event') return { ok: false, reason: 'non_event', amount: amount };
        if (dir === 'unclear')   return { ok: false, reason: 'unclear_direction', amount: amount };
        // 'reversal' falls through: it IS a real event and must be recorded.

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
                // The row stores a POSITIVE amount and this flag; the sign is
                // applied by get_camp_deposit_credits, so one place decides it.
                isReversal: isReversal,
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
