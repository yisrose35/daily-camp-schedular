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
//   • Deno          (supabase/functions/deposit-inbox, via _shared/)
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
// Adding a bank = adding an entry to EMAIL_RULES. Nothing else changes.
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
        'has\\s+been\\s+sent'
    ].join('|'), 'i');

    var INBOUND_RE = new RegExp([
        'you\\s+(?:have\\s+)?received',
        'sent\\s+you',
        'you\\s+got',
        'deposit(?:ed)?\\b',
        'credit(?:ed)?\\s+to\\s+your',
        'was\\s+credited',
        'incoming\\s+(?:transfer|payment|wire)',
        'money\\s+(?:has\\s+)?arrived'
    ].join('|'), 'i');

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
    P.direction = function (text) {
        var s = String(text || '');
        if (!s.trim()) return 'none';
        if (NON_EVENT_RE.test(s)) return 'none';
        if (OUTBOUND_RE.test(s)) return 'out';
        if (INBOUND_RE.test(s)) return 'in';
        return 'none';
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

    var MEMO_FIELD_RE = /\b(?:memo|note|message|comment|description|for)\s*[:\-]\s*["']?([^\n"'<]{1,120})/i;

    /** A Campistry family memo code: three letters, a dash, four digits. */
    P.MEMO_CODE_RE = /\b([A-Za-z]{3})[-\s]?([0-9]{4})\b/;

    P.parseMemo = function (text) {
        var s = String(text || '');
        var m = s.match(MEMO_FIELD_RE);
        if (m && m[1]) {
            var memo = m[1].trim().replace(/\s+/g, ' ');
            if (memo && !/^https?:/i.test(memo)) return memo;
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
    var NAME_TAIL_RE = /\s+(?:sent|has\s+sent|paid|via|with|using|on|to|for|through|and)\b[\s\S]*$/i;

    P.cleanName = function (raw) {
        var s = String(raw || '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^["'(\[]+|["')\]]+$/g, '')
            .replace(NAME_TAIL_RE, '')
            .replace(/[.,;:]+$/, '')
            .trim();
        // A bank that hides the name gives us asterisks -- that is not a name.
        if (!s || /^\*+$/.test(s)) return '';
        if (s.length > 80) s = s.slice(0, 80).trim();
        return s;
    };

    // ── per-bank email rules ─────────────────────────────────────────────────
    //
    // Ordered: the first rule that yields a payer name wins. Each is scoped by
    // a `test` so an unrelated bank's wording can't be misread by another
    // bank's pattern. GENERIC is last and intentionally loose.

    var EMAIL_RULES = [
        {
            bank: 'chase',
            test: /chase/i,
            // "JOHN SMITH sent you $50.00" / "You received $50.00 from JOHN SMITH"
            payer: [
                /you\s+received\s+\$?[0-9,.]*\s*from\s+([^\n.]{2,80})/i,
                /^\s*([^\n]{2,80}?)\s+sent\s+you\s+\$/im
            ]
        },
        {
            bank: 'bofa',
            test: /bank\s*of\s*america|bofa/i,
            payer: [
                /(?:received\s+(?:money|a\s+payment|\$[0-9,.]+)\s+from|from)\s*[:\-]?\s*([^\n.]{2,80})/i,
                /^\s*([^\n]{2,80}?)\s+sent\s+you\s+\$/im
            ]
        },
        {
            bank: 'wellsfargo',
            test: /wells\s*fargo/i,
            payer: [
                /you\s+received\s+\$?[0-9,.]*\s*from\s+([^\n.]{2,80})/i,
                /money\s+from\s+([^\n.]{2,80})/i
            ]
        },
        {
            bank: 'citi',
            test: /\bciti(?:bank)?\b/i,
            payer: [/you\s+received\s+\$?[0-9,.]*\s*from\s+([^\n.]{2,80})/i]
        },
        {
            bank: 'capitalone',
            test: /capital\s*one/i,
            payer: [
                /^\s*([^\n]{2,80}?)\s+sent\s+you\s+\$/im,
                /you\s+received\s+\$?[0-9,.]*\s*from\s+([^\n.]{2,80})/i
            ]
        },
        {
            bank: 'zelle',
            test: /zelle/i,
            payer: [
                /you\s+received\s+\$?[0-9,.]*\s*from\s+([^\n.]{2,80})/i,
                /^\s*([^\n]{2,80}?)\s+sent\s+you\s+\$/im
            ]
        },
        {
            bank: 'generic',
            test: /./,
            payer: [
                /(?:received|deposit(?:ed)?)\s+(?:of\s+)?\$?[0-9,.]*\s*from\s+([^\n.]{2,80})/i,
                /^\s*([^\n]{2,80}?)\s+sent\s+you\s+\$/im,
                /from\s*[:\-]\s*([^\n.]{2,80})/i,
                /(?:sender|payer|originator)\s*[:\-]\s*([^\n.]{2,80})/i
            ]
        }
    ];

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
        var full = (subject + '\n' + body).trim();

        if (!full) return { ok: false, reason: 'empty_message' };

        var dir = P.direction(full);
        if (dir === 'out')  return { ok: false, reason: 'outbound_payment' };
        if (dir !== 'in')   return { ok: false, reason: 'not_a_deposit' };

        var amount = P.parseAmountFromText(full);
        if (!amount) return { ok: false, reason: 'no_amount' };

        // Bank rules first; the descriptor parser is the fallback for alerts
        // that simply paste the statement line into the body.
        var payerName = '', bank = '';
        for (var i = 0; i < EMAIL_RULES.length; i++) {
            var rule = EMAIL_RULES[i];
            if (!rule.test.test(full)) continue;
            for (var j = 0; j < rule.payer.length; j++) {
                var hit = full.match(rule.payer[j]);
                if (hit && hit[1]) {
                    var nm = P.cleanName(hit[1]);
                    if (nm) { payerName = nm; bank = rule.bank; break; }
                }
            }
            if (payerName) break;
        }

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
    // tools/build_deposit_core.js, which bundles these two files verbatim.
    if (typeof globalThis !== 'undefined') globalThis.CampistryDepositParser = P;
    if (typeof window !== 'undefined') window.CampistryDepositParser = P;
    if (typeof module !== 'undefined' && module.exports) module.exports = P;
})();
