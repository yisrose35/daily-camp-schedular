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

// ── two rules, different failure modes ───────────────────────────────────────
//
// A template stores two independent ways to find each value:
//
//   the ANCHOR    "find this phrase, read what follows"
//   the LINE RULE "the value is on the line shaped like this, in this slot"
//
// Character offsets would be useless — a longer name shifts everything after
// it — but the SHAPE of a line is fixed, because the bank generates it from a
// template. The two break under different conditions, which is the entire
// reason for keeping both.

function teachFull(text) {
    return T.learn(text, {
        payerName: mark(text, 'YISRAEL ROSENFELD'),
        amount: mark(text, '$5.00'),
        memo: mark(text, 'tst 1234')
    }).template;
}

test('both methods are learned, and they agree on an unchanged layout', () => {
    const read = T.read(teachFull(SAMPLE), LATER);
    for (const field of ['payerName', 'amount', 'memo']) {
        assert.ok(read[field], field + ' was not read at all');
        assert.strictEqual(read[field].agree, true, field + ': the two methods disagreed');
    }
});

test('the line rule survives a bank inserting a banner above', () => {
    // Line NUMBERS shift; the line's SHAPE does not. Banks add marketing at the
    // top constantly, so a rule that counted lines from the top would break
    // every season.
    const read = T.read(teachFull(SAMPLE), 'LIMITED TIME: 3% APY on savings!\n\n' + LATER);
    assert.strictEqual(read.payerName.value, 'MIRIAM T. WEISSBERGER');
    assert.strictEqual(read.payerName.agree, true);
});

test('the line rule covers for an anchor the bank has reworded', () => {
    // This is the case the anchor alone cannot survive: its phrase is gone.
    // The payer's own line is untouched, so the line rule still finds it.
    const reworded = LATER.replace('Good news: Someone sent you money with Zelle®.', 'You have money waiting.');
    const read = T.read(teachFull(SAMPLE), reworded);
    assert.strictEqual(read.payerName.byAnchor, null, 'the anchor should be gone');
    assert.strictEqual(read.payerName.byLine, 'MIRIAM T. WEISSBERGER');
    assert.strictEqual(read.payerName.value, 'MIRIAM T. WEISSBERGER');
});

test('a value never runs past the end of its line', () => {
    // With the line restructured, the anchor still matches but its suffix is
    // missing from that line — and indexOf happily found the next occurrence
    // hundreds of characters later, returning a "payer name" containing three
    // paragraphs of the email.
    const restructured = LATER.replace(
        'MIRIAM T. WEISSBERGER has just sent you money with Zelle® in the amount of $1,250.00.',
        'You got $1,250.00 from MIRIAM T. WEISSBERGER via Zelle®.');
    const read = T.read(teachFull(SAMPLE), restructured);
    const got = read.payerName ? read.payerName.value : '';
    assert.ok(!got.includes('\n'), 'a field value must never span lines');
});

test('a lone surviving rule still has to produce something plausible', () => {
    // When one method dies the other answers alone, with no second opinion.
    // Extraction cannot tell it has matched in the wrong place — only knowing
    // the shape of a payer name can.
    assert.strictEqual(T.plausible('payerName', 'You got $1,250.00 from MIRIAM T. WEISSBERGER via Zelle®.'), false);
    assert.strictEqual(T.plausible('payerName', 'MIRIAM T. WEISSBERGER'), true);
    assert.strictEqual(T.plausible('payerName', "SHIMON'S HARDWARE LLC"), true);
    assert.strictEqual(T.plausible('amount', '$1,250.00'), true);
    assert.strictEqual(T.plausible('amount', 'MIRIAM T. WEISSBERGER'), false);

    const restructured = LATER.replace(
        'MIRIAM T. WEISSBERGER has just sent you money with Zelle® in the amount of $1,250.00.',
        'You got $1,250.00 from MIRIAM T. WEISSBERGER via Zelle®.');
    const read = T.read(teachFull(SAMPLE), restructured);
    assert.ok(!read.payerName, 'an implausible lone answer is dropped, not reported');
    // The memo line is untouched, so it still reads — fields stay independent.
    assert.strictEqual(read.memo.value, 'KLE-1234 tuition');
});

test('a template that no longer fits reports nothing rather than guessing', () => {
    const rewritten = 'Promo!\n\nYou got $1,250.00 from MIRIAM T. WEISSBERGER via Zelle®.\n\nNote from MIRIAM T. WEISSBERGER: KLE-1234 tuition';
    const read = T.read(teachFull(SAMPLE), rewritten);
    assert.ok(!read.payerName);
    assert.ok(!read.amount);
    // Falling back to the generic parser is the right answer here, and silence
    // is what tells the caller to do that.
});

// ── cross-camp corroboration ─────────────────────────────────────────────────

test('two camps teaching the same layout produce the same hash', () => {
    // This is what promotion is counted over, so it must be identical when two
    // camps independently teach the same bank — with entirely different
    // families, amounts and memos — and different the moment the rules differ.
    const other = [
        'Good news: Someone sent you money with Zelle®.',
        '',
        'MIRIAM WEISSBERGER has just sent you money with Zelle® in the amount of $920.00.',
        '',
        "Here's the message from MIRIAM WEISSBERGER: ABC-9876",
        '',
        'The money has already been deposited in your account.'
    ].join('\n');

    const a = T.learn(SAMPLE, {
        payerName: mark(SAMPLE, 'YISRAEL ROSENFELD'),
        amount: mark(SAMPLE, '$5.00'),
        memo: mark(SAMPLE, 'tst 1234')
    }, { bank: 'Capital One' });
    const b = T.learn(other, {
        payerName: mark(other, 'MIRIAM WEISSBERGER'),
        amount: mark(other, '$920.00'),
        memo: mark(other, 'ABC-9876')
    }, { bank: 'capital one bank' });   // typed differently on purpose

    assert.ok(a.ok && b.ok);
    assert.strictEqual(T.hash(a.template), T.hash(b.template));
});

test('the hash ignores what the camp typed and follows only the rules', () => {
    const a = teachFull(SAMPLE);
    const b = JSON.parse(JSON.stringify(a));
    b.meta = { bank: 'something else entirely', taughtAt: '2026-09-11' };
    assert.strictEqual(T.hash(a), T.hash(b), 'meta must not affect corroboration');

    b.fields.payerName.suffix = ' XX';
    assert.notStrictEqual(T.hash(a), T.hash(b), 'a real rule change must change the hash');
});

test('a contaminated anchor cannot reach the sharing threshold', () => {
    // The structural defence behind promotion: correct templates converge on
    // one hash because boilerplate is identical everywhere, while anything
    // carrying a family name or an account number is unique to the camp that
    // produced it and can never be corroborated by two others.
    const contaminated = { fields: { memo: { prefix: ['from YISRAEL ROSENFELD: '], suffix: '\n', line: null } } };
    assert.strictEqual(T.isShareable(contaminated), false);
    assert.notStrictEqual(T.hash(contaminated), T.hash(teachFull(SAMPLE)));
});
