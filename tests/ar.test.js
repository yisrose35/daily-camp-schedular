// node --test tests/ar.test.js
//
// Five things that are one domain: an invoice is not a statement, aging is what
// makes "past due" mean anything, a late fee is assessed against an aged invoice, a
// write-off ends one, and who-owes-me is a query over all of it.
//
// THE PRINCIPLE THAT RUNS THROUGH ALL OF IT, same as campistry_installments.js: a
// family is late because they were ASKED and did not pay. A camp that forgot to bill
// for two months has families who owe nothing yet, not families 60 days late —
// aging them would put the camp's own delay onto the family's record.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const A = require(path.join(__dirname, '..', 'campistry_ar.js'));

const inv = (id, amount, dueDate, extra) => Object.assign(
    { id, kind: 'invoice', amount, dueDate, paid: 0, status: 'open' }, extra || {});
const stmt = (id, amount) => ({ id, kind: 'statement', amount, status: 'open' });

// ── an invoice is not a statement ──────────────────────────────────────────

test('only an invoice asks for money', () => {
    assert.strictEqual(A.asks('invoice'), true);
    assert.strictEqual(A.asks('statement'), false);
    assert.strictEqual(A.asks('nonsense'), false);
    assert.strictEqual(A.asks(), false);
});

test('an invoice gets a due date; a statement CANNOT have one', () => {
    // A statement carrying a due date would age, and a document that asks for
    // nothing cannot be late. Enforced here rather than left to the caller.
    const i = A.buildDoc({ kind: 'invoice', amount: 500, issuedOn: '2026-03-01' });
    assert.strictEqual(i.dueDate, '2026-03-31', 'issue date plus the default 30 days');
    assert.strictEqual(i.termsDays, 30);

    const s = A.buildDoc({ kind: 'statement', amount: 500, issuedOn: '2026-03-01',
                           dueDate: '2026-03-31', termsDays: 14 });
    assert.strictEqual(s.dueDate, undefined, 'a statement must never carry a due date');
    assert.strictEqual(s.termsDays, undefined);
});

test('a camp can set its own terms, and an explicit due date wins', () => {
    assert.strictEqual(A.buildDoc({ kind: 'invoice', issuedOn: '2026-03-01', termsDays: 14 }).dueDate,
        '2026-03-15');
    assert.strictEqual(A.buildDoc({ kind: 'invoice', issuedOn: '2026-03-01', termsDays: 0 }).dueDate,
        '2026-03-01', 'due on receipt is a real choice');
    assert.strictEqual(A.buildDoc({ kind: 'invoice', issuedOn: '2026-03-01',
                                    dueDate: '2026-06-01' }).dueDate, '2026-06-01');
    // Nonsense terms fall back rather than producing an invalid date.
    assert.strictEqual(A.buildDoc({ kind: 'invoice', issuedOn: '2026-03-01', termsDays: -5 }).dueDate,
        '2026-03-31');
});

test('an unknown kind becomes a statement, which is the harmless one', () => {
    assert.strictEqual(A.buildDoc({ kind: 'demand', amount: 100 }).kind, 'statement');
});

// ── aging ──────────────────────────────────────────────────────────────────

test('the buckets cover every number of days without a gap', () => {
    [[-99, 'current'], [0, 'current'], [1, 'd1_30'], [30, 'd1_30'], [31, 'd31_60'],
     [60, 'd31_60'], [61, 'd61_90'], [90, 'd61_90'], [91, 'd90p'], [9999, 'd90p']]
        .forEach(([days, id]) => assert.strictEqual(A.bucketFor(days), id, String(days)));
});

test('aging separates what is late from what is merely owed', () => {
    const aged = A.age({
        docs: [inv('a', 100, '2026-02-01'), inv('b', 200, '2026-04-30')],
        asOf: '2026-03-15'
    });
    assert.strictEqual(aged.total, 300, 'a balance is not only what is overdue');
    assert.strictEqual(aged.pastDue, 100, 'only the one whose date has passed');
    assert.strictEqual(aged.buckets.d31_60, 100);
    assert.strictEqual(aged.buckets.current, 200);
    assert.strictEqual(aged.oldestDays, 42);
});

test('due exactly today is NOT past due', () => {
    // The boundary that decides whether a family gets a chasing letter on the day
    // the invoice falls due. Nothing in the earlier cases lands on it, which is how
    // a mutation widening past-due to include day zero stayed green.
    const aged = A.age({ docs: [inv('a', 100, '2026-03-15')], asOf: '2026-03-15' });
    assert.strictEqual(aged.pastDue, 0, 'they have until the end of the day they were given');
    assert.strictEqual(aged.total, 100, 'still owed, just not late');
    assert.strictEqual(aged.buckets.current, 100);
    assert.strictEqual(aged.oldestDays, 0);
    // And one day later it is.
    assert.strictEqual(A.age({ docs: [inv('a', 100, '2026-03-15')], asOf: '2026-03-16' }).pastDue, 100);
});

test('statements are never aged', () => {
    // They ask for nothing, so they cannot be late.
    const aged = A.age({ docs: [stmt('s', 5000)], asOf: '2030-01-01' });
    assert.strictEqual(aged.total, 0);
    assert.strictEqual(aged.pastDue, 0);
});

test('a settled or written-off invoice is not owed', () => {
    ['paid', 'written_off', 'void'].forEach(status => {
        const aged = A.age({ docs: [inv('a', 100, '2026-01-01', { status })], asOf: '2026-06-01' });
        assert.strictEqual(aged.total, 0, status + ' must not be owed');
    });
});

test('a part-paid invoice ages only what is left', () => {
    const aged = A.age({ docs: [inv('a', 500, '2026-01-01', { paid: 400 })], asOf: '2026-02-01' });
    assert.strictEqual(aged.total, 100);
    assert.strictEqual(aged.pastDue, 100);
    // Fully paid is not owed at all, even if the date is long gone.
    assert.strictEqual(A.age({ docs: [inv('a', 500, '2020-01-01', { paid: 500 })] }).total, 0);
});

test('the worst one comes first, because that is the order calls get made in', () => {
    const aged = A.age({
        docs: [inv('new', 10, '2026-03-10'), inv('old', 20, '2026-01-01'),
               inv('mid', 30, '2026-02-01')],
        asOf: '2026-03-15'
    });
    assert.deepStrictEqual(aged.items.map(i => i.id), ['old', 'mid', 'new']);
});

test('describeAging says nothing at all about a clean account', () => {
    assert.strictEqual(A.describeAging(A.age({ docs: [inv('a', 100, '2026-12-01')],
                                               asOf: '2026-03-01' })), '');
    assert.match(A.describeAging(A.age({ docs: [inv('a', 420, '2026-01-01')],
                                         asOf: '2026-02-17' })), /420\.00 past due/);
    assert.strictEqual(A.describeAging(null), '');
});

// ── the who-owes-me inquiry ────────────────────────────────────────────────

const FAMS = [
    { key: 'f1', name: 'Stein', docs: [inv('a', 500, '2026-01-01')], lastPaymentOn: '2025-12-01' },
    { key: 'f2', name: 'Klein', docs: [inv('b', 100, '2026-03-01')], lastPaymentOn: '2026-03-10' },
    { key: 'f3', name: 'Weiss', docs: [inv('c', 50, '2026-06-01')] },       // not yet due
    { key: 'f4', name: 'Gross', docs: [stmt('d', 9999)] }                    // asks nothing
];

test('the inquiry finds who is late and puts the worst first', () => {
    const r = A.inquire({ families: FAMS, asOf: '2026-03-20', minPastDue: 1 });
    assert.deepStrictEqual(r.rows.map(x => x.key), ['f1', 'f2'],
        'not the not-yet-due family, and not the statement');
    assert.strictEqual(r.rows[0].key, 'f1', 'largest past due leads');
    assert.strictEqual(r.totals.pastDue, 600);
});

test('it filters by how late, by bucket, and by how much', () => {
    assert.deepStrictEqual(
        A.inquire({ families: FAMS, asOf: '2026-03-20', minDaysLate: 60 }).rows.map(x => x.key),
        ['f1']);
    assert.deepStrictEqual(
        A.inquire({ families: FAMS, asOf: '2026-03-20', bucket: 'd1_30' }).rows.map(x => x.key),
        ['f2']);
    assert.deepStrictEqual(
        A.inquire({ families: FAMS, asOf: '2026-03-20', minPastDue: 200 }).rows.map(x => x.key),
        ['f1']);
});

test('a past-due family who has NEVER paid is included', () => {
    // The worst case in the book, and the one a blank lastPaymentOn could silently
    // exclude. None of the other fixtures combine "never paid" with "past due",
    // which is how a mutation dropping them stayed green.
    const neverPaid = [{ key: 'fx', name: 'Never', docs: [inv('z', 300, '2026-01-01')] }];
    const r = A.inquire({ families: neverPaid, asOf: '2026-03-20',
                          noPaymentSince: '2026-02-01' });
    assert.deepStrictEqual(r.rows.map(x => x.key), ['fx'],
        'never having paid must match "nobody who has paid since", not be skipped');
    assert.strictEqual(r.rows[0].lastPaymentOn, '');
});

test('"nobody who has paid recently" INCLUDES those who never paid', () => {
    // They are exactly who the query is looking for. Treating a blank as "paid
    // recently" would hide the worst cases, which is the opposite of the point.
    const r = A.inquire({ families: FAMS, asOf: '2026-03-20', minPastDue: 1,
                          noPaymentSince: '2026-02-01' });
    assert.deepStrictEqual(r.rows.map(x => x.key), ['f1'],
        'f2 paid in March so is excluded; f1 last paid in December so is included');
});

test('the inquiry totals its own rows and nothing else', () => {
    const r = A.inquire({ families: FAMS, asOf: '2026-03-20', minPastDue: 200 });
    assert.strictEqual(r.totals.pastDue, 500);
    // 2026-01-01 to 2026-03-20 is 78 days, so this lands in 61-90, not 31-60. My
    // first expectation here was wrong and the code was right; worth keeping the
    // arithmetic explicit so the next reader does not have to recount.
    assert.strictEqual(r.totals.buckets.d61_90, 500);
    assert.strictEqual(r.totals.buckets.d31_60, 0);
    assert.strictEqual(r.totals.buckets.d1_30, 0, 'f2 is not in this result set');
});

// ── late fees ──────────────────────────────────────────────────────────────

test('nobody is charged a late fee by default', () => {
    assert.strictEqual(A.normalizeLateFeePolicy({}).mode, 'off');
    assert.deepStrictEqual(A.assessLateFees({ docs: [inv('a', 500, '2020-01-01')] }), []);
});

test('a percentage fee is of what is outstanding', () => {
    const fees = A.assessLateFees({
        docs: [inv('a', 500, '2026-01-01', { paid: 100 })],
        policy: { mode: 'percent', percent: 1.5 }, asOf: '2026-01-15'
    });
    assert.strictEqual(fees.length, 1);
    assert.strictEqual(fees[0].amount, 6, '1.5% of the 400 still owed, not of the 500');
});

test('grace is honoured, and nothing is proposed inside it', () => {
    const args = { docs: [inv('a', 500, '2026-01-01')],
                   policy: { mode: 'flat', flat: 25, graceDays: 10 } };
    assert.deepStrictEqual(A.assessLateFees(Object.assign({}, args, { asOf: '2026-01-08' })), []);
    assert.strictEqual(A.assessLateFees(Object.assign({}, args, { asOf: '2026-01-20' })).length, 1);
});

test('a monthly fee compounds by period and the key changes with it', () => {
    // Running the same month twice must propose the SAME key, so the caller's dedupe
    // refuses the second. Next month must propose a different one.
    const p = { mode: 'flat', flat: 10, frequency: 'monthly' };
    const m1 = A.assessLateFees({ docs: [inv('a', 500, '2026-01-01')], policy: p, asOf: '2026-01-15' });
    const m1again = A.assessLateFees({ docs: [inv('a', 500, '2026-01-01')], policy: p, asOf: '2026-01-20' });
    const m3 = A.assessLateFees({ docs: [inv('a', 500, '2026-01-01')], policy: p, asOf: '2026-03-20' });
    assert.strictEqual(m1[0].key, m1again[0].key, 'the same period proposes the same key');
    assert.notStrictEqual(m1[0].key, m3[0].key, 'a later period proposes a new one');
    assert.strictEqual(m3[0].periods, 3);
    assert.strictEqual(m3[0].amount, 30);
});

test('a fee is capped per invoice when the camp says so', () => {
    const fees = A.assessLateFees({
        docs: [inv('a', 10000, '2026-01-01')],
        policy: { mode: 'percent', percent: 5, frequency: 'monthly', maxPerInvoice: 100 },
        asOf: '2026-09-01'
    });
    assert.strictEqual(fees[0].amount, 100, 'a runaway percentage must not outgrow the cap');
});

test('a small balance can be left alone', () => {
    assert.deepStrictEqual(A.assessLateFees({
        docs: [inv('a', 5, '2026-01-01')],
        policy: { mode: 'flat', flat: 25, minBalance: 50 }, asOf: '2026-03-01'
    }), [], 'a 25 fee on a 5 balance is not worth the phone call');
});

test('statements and settled invoices are never charged a fee', () => {
    const policy = { mode: 'flat', flat: 25 };
    assert.deepStrictEqual(A.assessLateFees({ docs: [stmt('s', 500)], policy, asOf: '2030-01-01' }), []);
    assert.deepStrictEqual(A.assessLateFees({
        docs: [inv('a', 500, '2020-01-01', { status: 'written_off' })], policy, asOf: '2030-01-01' }), []);
});

test('an out-of-range percentage is clamped, not trusted', () => {
    assert.strictEqual(A.normalizeLateFeePolicy({ mode: 'percent', percent: 500 }).percent, 100);
    assert.strictEqual(A.normalizeLateFeePolicy({ mode: 'percent', percent: -5 }).percent, 0);
});

// ── writing one off ────────────────────────────────────────────────────────

test('a write-off is a CREDIT with a reason, and closes the invoice as written off', () => {
    // Not a deletion and not an edit: the ledger is immutable and a camp has to be
    // able to report what it gave up on. And `written_off` is not `paid` — a report
    // that conflates them overstates collections.
    const p = A.planWriteOff({ doc: inv('a', 500, '2026-01-01', { paid: 120 }),
                               reason: 'family moved away, unreachable' });
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.amount, 380, 'only what is still outstanding');
    assert.deepStrictEqual(p.steps.map(s => s.do), ['credit', 'close']);
    assert.strictEqual(p.steps[0].ledgerReason, 'write_off');
    assert.match(p.steps[0].note, /family moved away/);
    assert.strictEqual(p.steps[1].status, 'written_off');
});

test('a write-off without a reason is refused', () => {
    // One with no reason is indistinguishable from a mistake.
    const p = A.planWriteOff({ doc: inv('a', 500, '2026-01-01') });
    assert.strictEqual(p.ok, false);
    assert.strictEqual(p.reason, 'no_reason');
    assert.deepStrictEqual(p.steps, []);
});

test('every write-off refusal returns no steps', () => {
    [[{ reason: 'x' }, 'no_invoice'],
     [{ doc: stmt('s', 100), reason: 'x' }, 'not_an_invoice'],
     [{ doc: inv('a', 100, '2026-01-01', { status: 'paid' }), reason: 'x' }, 'not_open'],
     [{ doc: inv('a', 100, '2026-01-01', { paid: 100 }), reason: 'x' }, 'nothing_owed']
    ].forEach(([arg, reason]) => {
        const p = A.planWriteOff(arg);
        assert.strictEqual(p.ok, false, reason);
        assert.strictEqual(p.reason, reason);
        assert.deepStrictEqual(p.steps, [], reason + ' must produce no steps');
        assert.ok(p.message.length > 0, reason + ' must say why');
    });
});

test('nothing here throws on rubbish', () => {
    [undefined, null, {}, 'x', 42, { docs: 'no' }, { families: 'no' }].forEach(arg => {
        assert.doesNotThrow(() => A.age(arg));
        assert.doesNotThrow(() => A.inquire(arg));
        assert.doesNotThrow(() => A.assessLateFees(arg));
        assert.doesNotThrow(() => A.planWriteOff(arg));
        assert.doesNotThrow(() => A.buildDoc(arg));
    });
});
