// @ts-nocheck
// =============================================================================
// AUTO-GENERATED — DO NOT EDIT.
//
// Generated from campistry_deposit_parser.js + campistry_deposit_match.js by
// tools/build_deposit_core.js. Edit those files and re-run:
//
//     node tools/build_deposit_core.js
//
// tests/deposit_core_sync.test.js fails if this file is out of date, so the
// server can never enforce different matching rules than the browser previews.
// =============================================================================

// ─── campistry_deposit_parser.js ─────────────────────────────────
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

// ─── campistry_deposit_match.js ──────────────────────────────────
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
    // tools/build_deposit_core.js, which bundles these two files verbatim.
    if (typeof globalThis !== 'undefined') globalThis.CampistryDepositMatch = M;
    if (typeof window !== 'undefined') window.CampistryDepositMatch = M;
    if (typeof module !== 'undefined' && module.exports) module.exports = M;
})();

// The two IIFEs above register themselves on globalThis; re-export them as
// proper ES modules for the edge function to import.
export const Parser = globalThis.CampistryDepositParser;
export const Matcher = globalThis.CampistryDepositMatch;
