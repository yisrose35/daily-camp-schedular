// node --test tests/deposit_teach_pdf.test.js
//
// Teaching a bank's layout from a printed email.
//
// The flow only earns its place if the rules it produces work on the LIVE
// email, which is a different document: a print-out wraps at the page margin,
// carries the mail client's own header and footer, and names the account that
// printed it. A template that reads the PDF perfectly and the real email not at
// all is the worst outcome here, because it looks like it worked.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../campistry_deposit_teach_pdf.js');
const T = require('../campistry_deposit_template.js');

// What a Gmail print-to-PDF of the Capital One alert contains: the client's
// header, the reading account, the body wrapped at the page margin, and the
// source URL and page number in the footer.
const PRINTED = [
    '9/11/26, 7:11 PM                    Gmail - Good news: Someone sent you money with Zelle',
    '',
    'Yisrael Rosenfeld <yisrose35@gmail.com>',
    'Mon, Sep 8, 2026 at 5:34 PM',
    'to me',
    '',
    'Good news: Someone sent you money with Zelle.',
    '',
    'YISRAEL ROSENFELD has just sent you money with',
    'Zelle in the amount of $5.00.',
    '',
    "Here's the message from YISRAEL",
    'ROSENFELD: KLE-1234',
    '',
    'The money has already been deposited in your',
    'account.',
    '',
    'https://mail.google.com/mail/u/0/?ik=abc123&view=pt',
    '1/2'
].join('\n');

// The same alert as the edge function actually receives it.
const LIVE_EMAIL = [
    'Good news: Someone sent you money with Zelle.',
    '',
    'MIRIAM T. WEISSBERGER has just sent you money with Zelle in the amount of $1,250.00.',
    '',
    "Here's the message from MIRIAM T. WEISSBERGER: GOL-5678 tuition",
    '',
    'The money has already been deposited in your account.'
].join('\n');

test('print chrome is removed before anything is learned', () => {
    const clean = P.stripChrome(PRINTED, ['yisrose35@gmail.com']);
    assert.ok(!clean.includes('Gmail - Good news'), 'client header');
    assert.ok(!clean.includes('yisrose35@gmail.com'), 'the reading account');
    assert.ok(!clean.includes('https://mail.google.com'), 'footer URL');
    assert.ok(!/^\s*1\/2\s*$/m.test(clean), 'page number');
    assert.ok(!/^\s*to me\s*$/m.test(clean), 'recipient line');
    // The email itself must survive intact.
    assert.ok(clean.includes('YISRAEL ROSENFELD has just sent you money'));
    assert.ok(clean.includes('KLE-1234'));
});

test('the reading account is stripped even mid-line', () => {
    // It belongs to whoever printed the page, and a template is something other
    // camps may end up running.
    const clean = P.stripChrome('Sent to office@thecamp.org for review\nYou received $5.00 from X',
                                ['office@thecamp.org']);
    assert.ok(!clean.includes('office@thecamp.org'));
    assert.ok(clean.includes('You received $5.00'));
});

test('a page-wrapped print and the live email normalise to the same text', () => {
    // The heart of it. The PDF breaks "has just sent you money with / Zelle in
    // the amount of $5.00." across two lines; the email does not. Unless those
    // converge, every line rule learned from a print-out is dead on arrival.
    const printedBody = P.stripChrome(PRINTED, ['yisrose35@gmail.com']);
    const sameAsEmail = [
        'Good news: Someone sent you money with Zelle.',
        '',
        'YISRAEL ROSENFELD has just sent you money with Zelle in the amount of $5.00.',
        '',
        "Here's the message from YISRAEL ROSENFELD: KLE-1234",
        '',
        'The money has already been deposited in your account.'
    ].join('\n');
    assert.strictEqual(
        T.normalize(printedBody).replace(/\n{2,}/g, '\n\n').trim(),
        T.normalize(sameAsEmail).replace(/\n{2,}/g, '\n\n').trim()
    );
});

test('a template taught from a PDF reads a real email correctly', () => {
    // The whole claim, end to end: teach from the print-out, read the live
    // email — a different family, a different amount, a different memo.
    const body = P.stripChrome(PRINTED, ['yisrose35@gmail.com']);
    const norm = T.normalize(body);
    const at = (v) => {
        const i = norm.indexOf(v);
        assert.notStrictEqual(i, -1, `normalised print-out has no ${JSON.stringify(v)}`);
        return { start: i, end: i + v.length };
    };

    const res = T.learn(norm, {
        payerName: at('YISRAEL ROSENFELD'),
        amount: at('$5.00'),
        memo: at('KLE-1234')
    }, { bank: 'Capital One', source: 'pdf' });
    assert.ok(res.ok, 'learn failed: ' + JSON.stringify(res.errors));

    const got = T.apply(res.template, LIVE_EMAIL);
    assert.strictEqual(got.payerName, 'MIRIAM T. WEISSBERGER');
    assert.strictEqual(got.amount, '$1,250.00');
    assert.strictEqual(got.memo, 'GOL-5678 tuition');
});

test('a selection outside the text layer is not mistaken for a highlight', () => {
    // A stray click produces a collapsed selection. Treating that as "they
    // highlighted nothing" would store a zero-length mark and learn a rule from
    // a position that points at nothing.
    const root = { contains: () => true };
    assert.strictEqual(P.offsetsFromSelection(root, null), null);
    assert.strictEqual(P.offsetsFromSelection(root, { isCollapsed: true, rangeCount: 1 }), null);
    assert.strictEqual(P.offsetsFromSelection(root, { isCollapsed: false, rangeCount: 0 }), null);
});
