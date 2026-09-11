// =============================================================================
// campistry_deposit_teach_pdf.js — teach a bank's layout from a printed PDF
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FLOW
//
//   1. The camp opens one of its bank's deposit alerts and prints it to PDF.
//      Every mail client can do this and every office knows how; nobody has to
//      be told what "the raw email text" is or where to find it.
//   2. They upload that PDF here.
//   3. The page renders, and a prompt asks for one thing at a time:
//        "Highlight the sender's name"  -> drag across it -> Done
//        "Highlight the amount"         -> drag          -> Done
//        "Highlight the memo"           -> drag          -> Done
//   4. campistry_deposit_template.js turns those three selections into rules,
//      and every later alert from that bank is read by them.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW A SELECTION BECOMES A RULE
//
// PDF.js gives each page's text as positioned items, not as a document. Two
// things are built from it in one pass, and they must stay in step or the
// highlight will not describe what the camp thinks it does:
//
//   • a plain-text rendering, which is what the template rules are learned
//     against (and what the edge function will later see from the real email)
//   • a <span> per item, each tagged with its offset range in that text
//
// A drag-selection then maps back to character offsets by asking which spans
// it starts and ends in — the same { start, end } shape the paste-an-email
// path produces, so both feed one learner and there is one set of rules to
// keep correct.
//
// WHY THE PDF AND THE EMAIL AGREE
//
// A PDF wraps at the page margin; an email wraps at the client's width. The
// same sentence is therefore split in different places, and a line rule learned
// from one would fire on neither the other nor anything in between — teaching
// from a print-out would produce rules that never work, while looking like they
// had. T.normalize() unwraps hard-wrapped lines back into logical ones on both
// sides, so the two converge before anything is learned.
//
// PRINT CHROME
//
// A printed page carries things the email never had: the client's own header,
// the reading account's address, a page number, the source URL in the footer.
// Left in, they are just more text a rule could accidentally anchor on — and
// the reading account's own address is the last thing that should end up in a
// template that other camps might share. They are removed before learning.
// =============================================================================
(function () {
    'use strict';

    var P = {};
    var W = typeof window !== 'undefined' ? window : {};

    P.FIELD_ORDER = ['payerName', 'amount', 'memo'];
    P.PROMPTS = {
        payerName: {
            title: 'Highlight who sent the money',
            help: 'Drag across the sender\'s name — the person or business, exactly as the bank prints it.'
        },
        amount: {
            title: 'Highlight the amount',
            help: 'Drag across the dollar figure that was deposited. Not a balance, not a fee.'
        },
        memo: {
            title: 'Highlight the memo',
            help: 'Drag across the note the sender typed. Skip this one if the bank does not show a memo.'
        }
    };

    // Lines a print-out adds that the email itself never contained.
    var CHROME_RES = [
        /^\s*\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/i,        // print timestamp
        /^\s*(?:Gmail|Outlook|Yahoo(?:\s+Mail)?|Mail)\s*[-–—]\s*/i, // client header
        /^\s*https?:\/\//i,                                         // footer URL
        /^\s*\d+\s*\/\s*\d+\s*$/,                                   // 1/2
        /^\s*Page\s+\d+(?:\s+of\s+\d+)?\s*$/i,
        /^\s*to\s+me\s*$/i,                                         // Gmail recipient line
        /^\s*(?:Reply|Forward|Reply all)\s*$/i,
        // Gmail's own date line: "Mon, Sep 8, 2026 at 5:34 PM". Safe to drop —
        // this text is only ever used for TEACHING, and the deposit's date comes
        // from the live email, never from a print-out somebody made days later.
        /^\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,\s+\w+\s+\d{1,2},\s+\d{4}\b/i,
        /^\s*(?:Date|Sent|Subject|From|To|Cc)\s*:/i
    ];

    /**
     * Strip print chrome, and the reading account's own address.
     *
     * The address matters beyond tidiness: it belongs to the person who printed
     * the page, and a template is something other camps may end up running.
     */
    P.stripChrome = function (text, ownAddresses) {
        var own = (ownAddresses || []).filter(Boolean).map(function (a) {
            return String(a).toLowerCase();
        });
        return String(text || '').split('\n').filter(function (line) {
            for (var i = 0; i < CHROME_RES.length; i++) {
                if (CHROME_RES[i].test(line)) return false;
            }
            var low = line.toLowerCase();
            for (var j = 0; j < own.length; j++) {
                if (own[j] && low.indexOf(own[j]) !== -1) return false;
            }
            return true;
        }).join('\n');
    };

    /**
     * Read a PDF into { text, items } where every item knows its offset range.
     *
     * Line breaks are inferred from the vertical position of each item, because
     * PDF.js reports position rather than structure -- a PDF has no notion of a
     * line at all. Items whose baseline has moved start a new line; a large jump
     * is a paragraph break, which is what keeps a bank's blocks apart.
     */
    P.readPdf = async function (arrayBuffer, pdfjsLib) {
        var lib = pdfjsLib || W.pdfjsLib;
        if (!lib) throw new Error('PDF support did not load.');

        var doc = await lib.getDocument({ data: arrayBuffer }).promise;
        var text = '';
        var items = [];
        var pages = [];

        for (var p = 1; p <= doc.numPages; p++) {
            var page = await doc.getPage(p);
            var content = await page.getTextContent();
            var viewport = page.getViewport({ scale: 1 });
            var lastY = null;

            for (var i = 0; i < content.items.length; i++) {
                var it = content.items[i];
                if (!it.str) continue;
                var y = it.transform[5];

                if (lastY !== null) {
                    var dy = Math.abs(y - lastY);
                    // A baseline that has not moved is the same line; a small
                    // move is the next line; a big one is a new block.
                    if (dy > 1) text += (dy > (it.height || 10) * 1.6) ? '\n\n' : '\n';
                    else if (!/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
                }
                lastY = y;

                var start = text.length;
                text += it.str;
                items.push({
                    page: p, start: start, end: text.length,
                    x: it.transform[4], y: y,
                    w: it.width, h: it.height || 10, str: it.str
                });
            }
            text += '\n\n';
            lastY = null;
            pages.push({ page: page, viewport: viewport });
        }

        return { doc: doc, text: text, items: items, pages: pages };
    };

    /**
     * Turn a DOM selection over the rendered spans into character offsets.
     *
     * Returns null when the selection is empty or lands outside the text layer,
     * which is the common case of a stray click and must not be mistaken for a
     * highlight of nothing.
     */
    P.offsetsFromSelection = function (root, sel) {
        var s = sel || (W.getSelection && W.getSelection());
        if (!s || s.isCollapsed || !s.rangeCount) return null;
        var range = s.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) return null;

        function spanOf(node) {
            var n = node;
            while (n && n !== root) {
                if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-start')) return n;
                n = n.parentNode;
            }
            return null;
        }

        var a = spanOf(range.startContainer);
        var b = spanOf(range.endContainer);
        if (!a || !b) return null;

        var start = parseInt(a.getAttribute('data-start'), 10) + (range.startOffset || 0);
        var end = parseInt(b.getAttribute('data-start'), 10) + (range.endOffset || 0);
        if (!(end > start)) return null;
        return { start: start, end: end, text: String(s.toString()) };
    };

    if (typeof window !== 'undefined') window.CampistryDepositTeachPdf = P;
    if (typeof module !== 'undefined' && module.exports) module.exports = P;
})();
