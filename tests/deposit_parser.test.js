// node --test tests/deposit_parser.test.js
//
// The parser is the front door for money entering the ledger automatically, so
// these tests lean hard on the two failure modes that actually cost a camp:
//   • booking an OUTGOING payment as income (invents money)
//   • booking a request/failure notice as income (invents money)
// Missing a real deposit is recoverable; both of the above are not.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../campistry_deposit_parser.js');

// ── direction: the safety gate ───────────────────────────────────────────────

test('an outbound payment alert is never a deposit', () => {
    [
        'You sent $250.00 to ACME CAMP SUPPLY with Zelle',
        'Your Zelle payment to John Smith was delivered',
        'A withdrawal of $80.00 was made from your account',
        'Transfer to savings completed'
    ].forEach(s => {
        assert.strictEqual(P.direction(s), 'out', s);
        assert.strictEqual(P.parseEmail({ subject: s, text: s }).ok, false, s);
    });
});

test('requests, reminders and failures are positively identified, not merely unrecognised', () => {
    // These must come back 'non_event', never 'unclear'. The difference decides
    // whether the message is discarded or kept for a human: 'non_event' means
    // we read it and it is not income, 'unclear' means we understood nothing
    // and something real may be hiding in it. Collapsing the two either buries
    // the office in newsletters or loses a deposit — the original code returned
    // 'none' for both, and lost deposits.
    [
        'John Smith is requesting $500.00 from you',
        'Reminder: your payment is due',
        'Your Zelle payment did not go through',
        'The transfer was returned',
        'You have been enrolled in Zelle'
    ].forEach(s => {
        assert.strictEqual(P.direction(s), 'non_event', s);
        assert.strictEqual(P.parseEmail({ subject: s, text: s }).ok, false, s);
    });
});

test('wording we recognise nothing in is reported as unclear', () => {
    assert.strictEqual(P.direction('ORIG CO NAME:ACME TRACE#:0210000298765'), 'unclear');
    assert.strictEqual(P.direction(''), 'unclear');
});

test('an outbound alert that also says "received" is still rejected', () => {
    // Real alerts do contain both words. Outbound must win the tie.
    const s = 'You sent $100.00 to Bob. Bob received your payment.';
    assert.strictEqual(P.direction(s), 'out');
});

// ── real-world bank alert shapes ─────────────────────────────────────────────

test('Chase Zelle alert', () => {
    const r = P.parseEmail({
        subject: 'You received $850.00 from SHIMON\'S HARDWARE LLC',
        text: 'Chase\nYou received $850.00 from SHIMON\'S HARDWARE LLC with Zelle on Jul 8, 2026.\nMemo: KLE-4821\nYour available balance is $12,904.55',
        receivedAt: '2026-07-08T14:03:00Z'
    });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.deposit.amount, 850);
    assert.strictEqual(r.deposit.payerName, "SHIMON'S HARDWARE LLC");
    assert.strictEqual(r.deposit.memoCode, 'KLE-4821');
    assert.strictEqual(r.deposit.date, '2026-07-08');
    assert.strictEqual(r.deposit.kind, 'zelle');
});

test('the balance line is never mistaken for the amount', () => {
    const r = P.parseEmail({
        subject: 'Deposit alert',
        text: 'Bank of America\nYou received money from RIVKA GOLDBERG\nAmount: $1,200.00\nAvailable balance: $48,300.19'
    });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.deposit.amount, 1200);
    assert.strictEqual(r.deposit.payerName, 'RIVKA GOLDBERG');
});

test('Wells Fargo "with Zelle" phrasing', () => {
    const r = P.parseEmail({
        subject: 'You received $325.00 from Miriam Weiss with Zelle®',
        text: 'Wells Fargo: You received $325.00 from Miriam Weiss with Zelle on 07/09/2026.'
    });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.deposit.amount, 325);
    assert.strictEqual(r.deposit.payerName, 'Miriam Weiss');
    assert.strictEqual(r.deposit.date, '2026-07-09');
});

test('Capital One "X sent you" phrasing', () => {
    const r = P.parseEmail({
        subject: 'MENDEL KATZ sent you $600.00',
        text: 'Capital One\nMENDEL KATZ sent you $600.00 with Zelle.'
    });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.deposit.payerName, 'MENDEL KATZ');
    assert.strictEqual(r.deposit.amount, 600);
});

test('an HTML-only alert is flattened and parsed', () => {
    const r = P.parseEmail({
        subject: 'Deposit',
        html: '<html><body><table><tr><td>You received <b>$450.00</b> from ' +
              '<span>ABE FRIEDMAN</span></td></tr><tr><td>Note: tuition</td></tr></table></body></html>'
    });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.deposit.amount, 450);
    assert.strictEqual(r.deposit.payerName, 'ABE FRIEDMAN');
    assert.strictEqual(r.deposit.memo, 'tuition');
});

test('a deposit with an unreadable payer is still captured', () => {
    // Must reach the reconcile inbox, not the bin -- the money is real.
    const r = P.parseEmail({ subject: 'Deposit posted', text: 'A deposit of $75.00 was posted to your account.' });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.deposit.amount, 75);
    assert.strictEqual(r.deposit.payerName, '');
});

test('an alert with no amount is rejected', () => {
    assert.strictEqual(P.parseEmail({ subject: 'You received a payment', text: 'You received a payment.' }).ok, false);
});

// ── ACH statement descriptors ────────────────────────────────────────────────

test('NACHA ORIG CO NAME descriptor', () => {
    const d = P.parseDescriptor('ORIG CO NAME:GOLDSTEIN DENTAL PC ORIG ID:1234567890 DESC DATE:070826 ENTRY DESCR:TUITION TRACE#:021000029876543');
    assert.strictEqual(d.payerName, 'GOLDSTEIN DENTAL PC');
    assert.strictEqual(d.kind, 'ach');
    assert.strictEqual(d.traceId, '021000029876543');
});

test('Zelle bank descriptor', () => {
    const d = P.parseDescriptor('ZELLE FROM SARA LEVI ON 07/08 CONF 8H3KD91MZ');
    assert.strictEqual(d.payerName, 'SARA LEVI');
    assert.strictEqual(d.kind, 'zelle');
});

test('feed rows: credits parse, debits are dropped', () => {
    const credit = P.parseFeedRow({ date: '2026-07-08', amount: '1,500.00', description: 'ZELLE FROM YOSSI BRAND ON 07/08', type: 'credit' });
    assert.ok(credit.ok);
    assert.strictEqual(credit.deposit.amount, 1500);
    assert.strictEqual(credit.deposit.payerName, 'YOSSI BRAND');

    assert.strictEqual(P.parseFeedRow({ date: '2026-07-08', amount: '-90.00', description: 'ACH DEBIT UTILITIES' }).ok, false);
    assert.strictEqual(P.parseFeedRow({ date: '2026-07-08', amount: '90.00', description: 'X', type: 'debit' }).ok, false);
});

// ── dedupe ───────────────────────────────────────────────────────────────────

test('the same money from two sources collapses to one fingerprint', () => {
    // This is the guarantee that the email feed and the bank feed together do
    // not double-credit a family.
    const fromEmail = { date: '2026-07-08', amount: 850, payerName: "SHIMON'S HARDWARE LLC", traceId: '', source: 'email' };
    const fromFeed  = { date: '2026-07-08', amount: '850.00', payerName: "Shimon's Hardware LLC", traceId: '', source: 'feed' };
    assert.strictEqual(P.fingerprint(fromEmail), P.fingerprint(fromFeed));
});

test('different deposits do not collide', () => {
    const base = { date: '2026-07-08', amount: 850, payerName: 'A B', traceId: '' };
    const diffAmt  = Object.assign({}, base, { amount: 851 });
    const diffDate = Object.assign({}, base, { date: '2026-07-09' });
    const diffName = Object.assign({}, base, { payerName: 'C D' });
    const set = new Set([base, diffAmt, diffDate, diffName].map(P.fingerprint));
    assert.strictEqual(set.size, 4);
});

test('two identical-looking payments are separated by trace id', () => {
    // A family paying the same amount twice in one day is real, and both must
    // be booked.
    const a = { date: '2026-07-08', amount: 500, payerName: 'SARA LEVI', traceId: 'CONF111' };
    const b = { date: '2026-07-08', amount: 500, payerName: 'SARA LEVI', traceId: 'CONF222' };
    assert.notStrictEqual(P.fingerprint(a), P.fingerprint(b));
});

test('a plain (non-Zelle) deposit alert is classified as ACH, not Zelle', () => {
    const r = P.parseEmail({ subject: 'Deposit', text: 'You received $200.00 from ACME PAYROLL on 07/08/2026.' });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.deposit.kind, 'ach');
});

test('ORIG ID is never mistaken for the trace number', () => {
    // Both companies below share ORIG ID; only TRACE# distinguishes the two
    // payments. Getting this wrong merges distinct deposits and loses money.
    const a = P.parseDescriptor('ORIG CO NAME:GOLDSTEIN DENTAL PC ORIG ID:1234567890 TRACE#:021000029876543');
    const b = P.parseDescriptor('ORIG CO NAME:GOLDSTEIN DENTAL PC ORIG ID:1234567890 TRACE#:021000021111111');
    assert.strictEqual(a.traceId, '021000029876543');
    assert.strictEqual(b.traceId, '021000021111111');
    assert.notStrictEqual(
        P.fingerprint({ date: '2026-07-08', amount: 500, payerName: a.payerName, traceId: a.traceId }),
        P.fingerprint({ date: '2026-07-08', amount: 500, payerName: b.payerName, traceId: b.traceId })
    );
});

test('a forwarded alert names the payer, not the bank in the From: header', () => {
    // Forwarding is a first-class setup path -- a camp already receiving alerts
    // in another mailbox is told to forward them here. Every client wraps the
    // original in a header block, and the generic `from:` payer rule reads that
    // header: before this was fixed, a forwarded Chase alert booked
    // "Chase <no.reply.alerts@chase.com>" as the payer of every deposit. A
    // wrong name is worse than none, because the matcher scores against it.
    const r = P.parseEmail({
        subject: 'Fwd: Chase Alert',
        text: '---------- Forwarded message ---------\n' +
              'From: Chase <no.reply.alerts@chase.com>\n' +
              'Date: Tue, Jul 8, 2026\n' +
              'To: office@camp.org\n\n' +
              "You received $850.00 from SHIMON'S HARDWARE LLC"
    });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.deposit.amount, 850);
    assert.strictEqual(r.deposit.payerName, "SHIMON'S HARDWARE LLC");
});

test('the Outlook forward shape is handled too, and keeps the original subject', () => {
    const r = P.parseEmail({
        subject: 'FW: Deposit',
        text: '________________________________\n' +
              'From: Wells Fargo <alerts@wellsfargo.com>\n' +
              'Sent: Monday, July 8, 2026\n' +
              'To: Office\n' +
              'Subject: You received money\n\n' +
              'You received $425.00 from GOLDSTEIN DENTAL PC'
    });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.deposit.payerName, 'GOLDSTEIN DENTAL PC');
});

test('an email address is never accepted as a payer name', () => {
    // The last line of defence, for a client that forwards with no marker at
    // all. A bare address leaves nothing, which is the right answer: an unnamed
    // deposit waits for a human, a misnamed one gets matched to a stranger.
    assert.strictEqual(P.cleanName('yisrael rosenfeld <yisrose35@gmail.com>'), 'yisrael rosenfeld');
    assert.strictEqual(P.cleanName('no.reply.alerts@chase.com'), '');
});

test('a payer name keeps an intra-token period but stops at a sentence end', () => {
    // The capture used to exclude every '.', which truncated "gmail.com" mid
    // address -- the symptom that exposed the header bug. It must still stop
    // dead at a sentence boundary, or the name runs into the marketing copy.
    const bleed = P.parseEmail({
        subject: 'Chase alert',
        text: 'You received $50.00 from JOHN SMITH. View your account online at chase.com'
    });
    assert.strictEqual(bleed.deposit.payerName, 'JOHN SMITH');

    const inner = P.parseEmail({ subject: 'Chase Alert', text: 'You received $300.00 from ABC CO.LTD' });
    assert.strictEqual(inner.deposit.payerName, 'ABC CO.LTD');
});

test('the real Capital One Zelle alert parses completely', () => {
    // Transcribed from an actual Capital One alert. Every earlier fixture was
    // written from how I imagined banks word these; this one is ground truth,
    // and it broke three separate assumptions at once:
    //   * "has just" sits between the name and "sent", and the amount is a
    //     clause away — so `X sent you $` matched nothing and the deposit was
    //     recorded with no payer at all.
    //   * The Zelle memo is prose, "Here's the message from <PAYER>: <memo>",
    //     where the colon follows the payer rather than the word "message".
    //   * The bank's own name is only in the logo image, so "Capital One"
    //     never survives htmlToText. Only "Zelle" does.
    const text = [
        'Sign In',
        '',
        'Good news: Someone sent you money with Zelle®.',
        '',
        'YISRAEL ROSENFELD has just sent you money with Zelle® in the amount of $5.00.',
        '',
        "Here's the message from YISRAEL ROSENFELD: KLE-1234",
        '',
        'The money has already been deposited in your account, so you don\'t need',
        'to do anything—just sit back and enjoy that money-in-the-bank feeling.',
        '',
        'Thanks for using Zelle®, and enjoy the money well sent.'
    ].join('\n');

    const r = P.parseEmail({ subject: 'Someone sent you money with Zelle', text });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.deposit.amount, 5);
    assert.strictEqual(r.deposit.payerName, 'YISRAEL ROSENFELD');
    assert.strictEqual(r.deposit.memo, 'KLE-1234');
    assert.strictEqual(r.deposit.memoCode, 'KLE-1234');
    assert.strictEqual(r.deposit.kind, 'zelle');
});

test('the Capital One headline never becomes the payer', () => {
    // "Good news: Someone sent you money with Zelle." sits ABOVE the real line
    // and matches any loose "sent you money" rule first. Two independent
    // defences: the pattern requires a '$' on the same line (the headline has
    // none), and cleanName refuses the placeholder outright.
    assert.strictEqual(P.cleanName('Someone'), '');
    assert.strictEqual(P.cleanName('a friend'), '');

    const r = P.parseEmail({
        subject: 'Zelle',
        text: 'Good news: Someone sent you money with Zelle.\n\n' +
              'SARA LEVI has just sent you money with Zelle in the amount of $250.00.'
    });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.deposit.payerName, 'SARA LEVI');
});

test("'money well sent' in the footer does not trip the outbound gate", () => {
    // The direction gate runs before anything else and throws away whatever
    // looks outbound. Capital One's sign-off is "enjoy the money well sent" —
    // close enough to the deny-list to be worth pinning, because a false
    // positive here silently drops a real deposit.
    const r = P.parseEmail({
        subject: 'Zelle',
        text: 'SARA LEVI has just sent you money with Zelle in the amount of $250.00.\n' +
              'Thanks for using Zelle, and enjoy the money well sent.'
    });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.deposit.amount, 250);
});
