// node --test tests/deposit_template.test.js
//
// Teaching the reader one bank's layout from one example.
//
// The claim being tested is narrow and specific: a camp highlights the name,
// the amount and the memo in ONE of its emails, and every later email from
// that bank is read correctly — with different names, different lengths,
// different amounts. If that does not hold, the feature is theatre.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../campistry_deposit_template.js');

// The real Capital One alert, and a second payment in the same layout.
const SAMPLE = [
    'Good news: Someone sent you money with Zelle®.',
    '',
    'YISRAEL ROSENFELD has just sent you money with Zelle® in the amount of $5.00.',
    '',
    "Here's the message from YISRAEL ROSENFELD: tst 1234",
    '',
    'The money has already been deposited in your account.'
].join('\n');

const LATER = [
    'Good news: Someone sent you money with Zelle®.',
    '',
    'MIRIAM T. WEISSBERGER has just sent you money with Zelle® in the amount of $1,250.00.',
    '',
    "Here's the message from MIRIAM T. WEISSBERGER: KLE-1234 tuition",
    '',
    'The money has already been deposited in your account.'
].join('\n');

function mark(text, value) {
    const i = text.indexOf(value);
    assert.notStrictEqual(i, -1, `fixture does not contain ${JSON.stringify(value)}`);
    return { start: i, end: i + value.length };
}

function teach(text) {
    return T.learn(text, {
        payerName: mark(text, 'YISRAEL ROSENFELD'),
        amount: mark(text, '$5.00'),
        memo: mark(text, 'tst 1234')
    }, { bank: 'Capital One' });
}

test('one example teaches all three fields', () => {
    const r = teach(SAMPLE);
    assert.ok(r.ok, 'learn failed: ' + JSON.stringify(r.errors));
    assert.deepStrictEqual(Object.keys(r.template.fields).sort(), ['amount', 'memo', 'payerName']);
});

test('what was taught on one email reads a different payment correctly', () => {
    // The whole point. Different name (longer, with a middle initial), different
    // amount (four digits and a comma, where the sample had one digit), different
    // memo. Nothing about the values is reused — only the boilerplate around them.
    const r = teach(SAMPLE);
    assert.deepStrictEqual(T.apply(r.template, LATER), {
        payerName: 'MIRIAM T. WEISSBERGER',
        amount: '$1,250.00',
        memo: 'KLE-1234 tuition'
    });
});

test('an anchor never contains another value that varies', () => {
    // Capital One prints the payer TWICE: in the announcement line, and again
    // in "Here's the message from <PAYER>:". The memo sits right after the
    // second one, so a literal anchor reads "ROSENFELD: " — which reproduces
    // the sample perfectly and then loses the memo for every other family.
    // The payer's span must become a wildcard instead.
    const r = teach(SAMPLE);
    const memo = r.template.fields.memo;
    assert.ok(memo.prefix.includes(null), 'the memo anchor must wildcard the payer name');
    assert.ok(!memo.prefix.some(p => p && /ROSENFELD/i.test(p)),
        'no part of a family name may be baked into an anchor');
});

test('a terminator that also occurs inside the value is rejected', () => {
    // "in the amount of $5.00." — the characters after the highlight are ".",
    // and searching forward for "." lands on the decimal point INSIDE the
    // amount, yielding "$5". The suffix is chosen by replaying it against the
    // sample, so a candidate that cannot reproduce the value never gets stored.
    const r = teach(SAMPLE);
    assert.strictEqual(T.apply(r.template, SAMPLE).amount, '$5.00');
});

test('learn refuses a template it cannot replay on its own sample', () => {
    // A rule that cannot reproduce the answer it was just given will not do
    // better on mail nobody has checked, so it must not be saved.
    const r = T.learn(SAMPLE, { payerName: { start: 5, end: 5 } });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.length);
});

test('fields are independent — losing one does not lose the rest', () => {
    // Banks reword one line at a time. A template that still finds the amount
    // must return it, so the generic parser only has to cover the gap.
    const r = teach(SAMPLE);
    const reworded = LATER.replace("Here's the message from", 'Note attached from');
    const got = T.apply(r.template, reworded);
    assert.strictEqual(got.payerName, 'MIRIAM T. WEISSBERGER');
    assert.strictEqual(got.amount, '$1,250.00');
    assert.ok(!got.memo, 'the reworded line should simply be absent, not wrong');
});

test('line wrapping does not break a template', () => {
    // The same alert wraps differently depending on which client forwarded it.
    const r = teach(SAMPLE);
    const respaced = LATER.replace(/ /g, '  ');
    assert.strictEqual(T.apply(r.template, respaced).payerName, 'MIRIAM T. WEISSBERGER');
});

test('a bank is identified by its sending domain, not a typed name', () => {
    // "Chase", "chase bank" and "JPM Chase" are one bank and three strings.
    assert.strictEqual(T.signature('no.reply.alerts@email.capitalone.com'), 'email.capitalone.com');
    assert.strictEqual(T.signature('alerts@chase.com'), 'chase.com');
});

test('an anchor carrying personal data is never offered to another camp', () => {
    // Anchors are meant to be boilerplate, and boilerplate is safe to share.
    // A highlight that stops a character early bakes someone's data into one,
    // so anything with digits, an address or a long capitalised run stays
    // private to the camp that taught it.
    assert.strictEqual(T.isShareable(teach(SAMPLE).template), true);
    assert.strictEqual(T.isShareable({ fields: { amount: { prefix: ['acct 4321 '], suffix: '' } } }), false);
    assert.strictEqual(T.isShareable({ fields: { memo: { prefix: ['from YISRAEL ROSENFELD: '], suffix: '' } } }), false);
    assert.strictEqual(T.isShareable({ fields: { memo: { prefix: ['to office@camp.org '], suffix: '' } } }), false);
});
