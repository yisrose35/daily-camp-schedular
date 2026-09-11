// node --test tests/deposit_bank_corpus.test.js
//
// ─────────────────────────────────────────────────────────────────────────────
// THE POINT OF THIS FILE
//
// Every other test here was written from a fixture I invented. The first real
// bank alert we ever saw (Capital One) broke three assumptions at once, which
// is the expected outcome of testing a parser against your own imagination.
//
// A camp brings whatever bank it already has. There is no version of this
// feature where we have seen them all, so the parser must not be a pile of
// per-bank special cases -- it must handle wording it has never encountered.
// This corpus is how that claim gets checked: one message per bank, phrased
// differently on purpose, asserted as a SET rather than one at a time.
//
// The bar is deliberately two-sided, because the two failure modes are not
// symmetric:
//
//   COVERAGE  -- a deposit we cannot read is money that goes missing. Bad, but
//                recoverable: it lands in the inbox for a human.
//   SAFETY    -- an outgoing payment read as income credits a family for money
//                that never arrived. Unrecoverable, and invisible until the
//                family stops paying. This must be ZERO, always.
//
// So coverage is a threshold and safety is an absolute. When a real alert from
// a new bank shows up, add it here first and watch it fail.
// ─────────────────────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const P = require('../campistry_deposit_parser.js');

// Real-shaped inbound alerts. Wording varies on purpose: "sent you",
// "received from", "was credited", "has paid you", "Remitter:", a bare
// labelled field. Several are banks we have no rule for and never will.
const INBOUND = [
    ['chase zelle',   'You received $850.00 from SHIMON MILLER with Zelle®.\nMemo: KLE-1234', 850, 'SHIMON MILLER'],
    ['chase ach',     'A direct deposit of $1,200.00 from GOLDSTEIN DENTAL PC was posted to your account.', 1200, 'GOLDSTEIN DENTAL PC'],
    ['bofa',          'You received money from SARA LEVI\nAmount: $425.00', 425, 'SARA LEVI'],
    ['wells fargo',   'You received $300.00 from DAVID KLEIN via Zelle.', 300, 'DAVID KLEIN'],
    ['citi',          'You received $75.00 from RIVKA STERN.', 75, 'RIVKA STERN'],
    ['capital one',   'Good news: Someone sent you money with Zelle®.\n\nYISRAEL ROSENFELD has just sent you money with Zelle® in the amount of $5.00.\n\nHere’s the message from YISRAEL ROSENFELD: KLE-1234', 5, 'YISRAEL ROSENFELD'],
    ['us bank',       'Payment from MOSHE FRIEDMAN of $500.00 has been deposited.', 500, 'MOSHE FRIEDMAN'],
    ['pnc',           'PNC Alert: You have received a payment of $250.00 from LEAH WEISS.', 250, 'LEAH WEISS'],
    ['truist',        'Sender: AVI SCHWARTZ\nAmount: $600.00\nA Zelle payment was deposited into your account.', 600, 'AVI SCHWARTZ'],
    ['td bank',       'TD Bank: MIRIAM COHEN sent you $150.00.', 150, 'MIRIAM COHEN'],
    ['navy federal',  'Funds from BENJAMIN HOROWITZ in the amount of $325.00 were credited.', 325, 'BENJAMIN HOROWITZ'],
    ['ally',          'Deposit from ESTHER GREENBERG for $410.00 has cleared.', 410, 'ESTHER GREENBERG'],
    ['discover',      'You have received $95.00 from YAAKOV ADLER.', 95, 'YAAKOV ADLER'],
    ['schwab',        'Received from: CHANA BRAUN\nCredit: $1,000.00', 1000, 'CHANA BRAUN'],
    ['amex',          'JOSEPH MANDEL has paid you $220.00.', 220, 'JOSEPH MANDEL'],
    ['unknown bank a','Transfer from RACHEL FEIN of $180.00 was received.', 180, 'RACHEL FEIN'],
    ['unknown bank b','A payment of $45.00 from ARYEH LANDAU has been credited to your account.', 45, 'ARYEH LANDAU'],
    ['unknown bank c','Remitter: SHOSHANA WEISS\nAmount credited: $2,500.00', 2500, 'SHOSHANA WEISS']
];

test('every bank in the corpus yields both an amount and a payer', () => {
    const misses = [];
    for (const [bank, text, amount, payer] of INBOUND) {
        const r = P.parseEmail({ subject: 'Alert', text, receivedAt: '2026-07-08T00:00:00Z' });
        if (!r.ok) { misses.push(`${bank}: rejected as ${r.reason}`); continue; }
        if (r.deposit.amount !== amount) misses.push(`${bank}: amount ${r.deposit.amount} != ${amount}`);
        if (r.deposit.payerName !== payer) misses.push(`${bank}: payer ${JSON.stringify(r.deposit.payerName)} != ${JSON.stringify(payer)}`);
    }
    assert.deepStrictEqual(misses, [], 'corpus misses:\n  ' + misses.join('\n  '));
});

test('a trailing clause never rides along on the payer name', () => {
    // "GOLDSTEIN DENTAL PC was posted" scores differently from "GOLDSTEIN
    // DENTAL PC" and defeats an exact alias hit outright, so the family stops
    // auto-matching for no visible reason.
    for (const [bank, text] of INBOUND) {
        const r = P.parseEmail({ subject: 'Alert', text });
        if (!r.ok || !r.deposit.payerName) continue;
        const n = r.deposit.payerName;
        assert.ok(!/\$/.test(n), `${bank}: amount leaked into payer ${JSON.stringify(n)}`);
        assert.ok(n.split(/\s+/).length <= 6, `${bank}: payer looks like a clause: ${JSON.stringify(n)}`);
        assert.ok(!/\b(was|were|has been|posted|credited|received|deposited)\b/i.test(n),
            `${bank}: verb clause in payer ${JSON.stringify(n)}`);
    }
});

// The asymmetric half. Widening the inbound gate for coverage is exactly what
// puts these at risk, so they are checked in the same file, right next to it.
// NOTE: a RETURNED incoming deposit deliberately does not belong here. It is
// not "not income" -- it is negative income, and it has to be recorded so the
// family can be debited. See the reversal tests at the foot of this file.
const NOT_INCOME = [
    ['you sent',             'You sent $50.00 to JOHN SMITH with Zelle.'],
    ['you paid',             'You paid $120.00 to ACME CAMP SUPPLY.'],
    ['payment to',           'Your payment to CON ED of $300.00 was processed.'],
    ['transfer to savings',  'A transfer to your savings of $500.00 completed.'],
    ['debited',              'Your account was debited $75.00.'],
    ['from your account to', 'A payment from your checking account to ACME LLC for $250.00 was sent.'],
    ['authorized',           'You have authorized a payment of $99.00 to VERIZON.'],
    ['withdrawal',           'ATM withdrawal of $100.00.'],
    ['money request',        'SARA LEVI is requesting $200.00 from you.'],
    ['declined',             'Your payment of $60.00 was declined.'],
    ['due reminder',         'Reminder: your payment of $150.00 is due.'],
    ['zelle enrollment',     'You have enrolled in Zelle.'],
    ['card payment out',     'A payment from your card ending in 4321 to ACME was posted.']
];

test('nothing that is not incoming money is ever booked as a deposit', () => {
    // Zero tolerance. A missed deposit is a phone call; a phantom credit is a
    // family told they are paid up when they are not.
    const leaks = [];
    for (const [label, text] of NOT_INCOME) {
        const r = P.parseEmail({ subject: 'Alert', text });
        if (r.ok) leaks.push(`${label}: booked $${r.deposit.amount} from ${JSON.stringify(r.deposit.payerName)}`);
    }
    assert.deepStrictEqual(leaks, [], 'phantom credits:\n  ' + leaks.join('\n  '));
});

test('an unreadable message that mentions money is kept, not dropped', () => {
    // The single most dangerous outcome in this feature is a real deposit from
    // an unfamiliar bank being discarded with nothing stored. parseEmail must
    // therefore distinguish "recognised, and not income" from "recognised
    // nothing at all" — and report the amount either way, so the caller can
    // keep the ambiguous ones for a human.
    const unknown = P.parseEmail({
        subject: 'Account activity',
        text: 'ORIG CO NAME:KLEIN FAMILY TRUST ORIG ID:1234567890 TRACE#:021000029876543 AMOUNT $1,500.00'
    });
    assert.strictEqual(unknown.ok, false);
    assert.strictEqual(unknown.reason, 'unclear_direction');
    assert.strictEqual(unknown.amount, 1500, 'the amount must survive so the caller can keep this');
});

test('messages we positively recognise as not-income are still discarded', () => {
    // These must NOT reach the inbox. If everything is kept, the office stops
    // looking at the one thing that matters.
    for (const [label, text] of NOT_INCOME) {
        const r = P.parseEmail({ subject: 'Alert', text });
        assert.strictEqual(r.ok, false, label);
        assert.notStrictEqual(r.reason, 'unclear_direction',
            `${label} should be positively classified, not left ambiguous`);
    }
});

test('ordinary marketing mail does not become an inbox item', () => {
    // No amount anywhere means nothing to keep — the reason must not be
    // unclear_direction-with-an-amount, or every newsletter lands in the inbox.
    const r = P.parseEmail({ subject: 'Your July statement is ready', text: 'View your statement online. Manage alerts.' });
    assert.strictEqual(r.ok, false);
    assert.ok(!r.amount, 'no amount, so nothing is kept for review');
});

// ── returns / NSF ────────────────────────────────────────────────────────────
//
// A credit that already landed can be pulled back days later. This is the most
// consequential message in the feature: until it is handled, the family reads
// as PAID when the money is gone, and nobody finds out until the season ends.

test('a returned incoming deposit is recorded as a reversal', () => {
    const cases = [
        'A deposit of $400.00 from DAVID KLEIN was returned due to insufficient funds.',
        'Zelle payment of $250.00 from SARA LEVI — NSF, returned unpaid.',
        'Reversal of a credit of $120.00 received from ACME DENTAL.'
    ];
    for (const text of cases) {
        const r = P.parseEmail({ subject: 'Alert', text });
        assert.ok(r.ok, `${text} -> ${r.reason}`);
        assert.strictEqual(r.deposit.isReversal, true, text);
        assert.ok(r.deposit.amount > 0, 'the amount stays positive; the sign is applied on read');
        assert.ok(r.deposit.payerName, 'the payer must survive so the return can find its family');
    }
});

test('the return reason never rides along on the payer name', () => {
    // "SARA LEVI — NSF, returned unpaid" is a different string from "SARA LEVI"
    // and would not find the alias that matched the original deposit, so the
    // return would fail to reach the family it needs to debit.
    const r = P.parseEmail({ subject: 'Alert', text: 'Zelle payment of $250.00 from SARA LEVI — NSF, returned unpaid.' });
    assert.strictEqual(r.deposit.payerName, 'SARA LEVI');
    // A dash INSIDE a name is not a separator and must survive.
    const hy = P.parseEmail({ subject: 'Alert', text: 'You received $100.00 from SMITH-JONES LLC' });
    assert.strictEqual(hy.deposit.payerName, 'SMITH-JONES LLC');
});

test('our own outgoing payment bouncing back is not a family debit', () => {
    // Money does come back to the camp here, but it is not a family's payment
    // failing. Booking it against a family would debit someone at random.
    const r = P.parseEmail({ subject: 'Alert', text: 'Your payment to CON ED of $300.00 was returned.' });
    assert.strictEqual(r.ok, false);
});

test('a reversal never auto-posts, even with a valid memo code', () => {
    const M = require('../campistry_deposit_match.js');
    const r = P.parseEmail({ subject: 'Alert', text: 'A deposit of $400.00 from DAVID KLEIN was returned due to insufficient funds.' });
    const deposit = Object.assign({}, r.deposit, { memoCode: M.memoCode('fam_klein', 'Klein Family') });
    const decision = M.decide(deposit, { families: { fam_klein: { name: 'Klein Family' } }, aliases: [], balances: {} }, {});
    assert.strictEqual(decision.decision, 'review');
    assert.match(decision.guardrail, /return|reversal/i);
});

test('a return is never swallowed as a duplicate of the deposit it reverses', () => {
    // Same day, same amount, same payer, no trace number — which is ordinary
    // for a Zelle return. Without the reversal flag in the fingerprint these
    // collide, ON CONFLICT DO NOTHING drops the return, and the family keeps a
    // credit for money the bank has already taken back.
    const base = { date: '2026-07-08', amount: 400, payerName: 'DAVID KLEIN', traceId: '' };
    assert.notStrictEqual(
        P.fingerprint(base),
        P.fingerprint(Object.assign({}, base, { isReversal: true }))
    );
});
