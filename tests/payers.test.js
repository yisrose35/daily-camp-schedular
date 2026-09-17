// node --test tests/payers.test.js
//
// A camper belongs to exactly one household, and the whole ledger is built on it.
// Camps do not work that way: parents split tuition, a grandparent covers half, a
// shul fund pays a fixed $800 and the family covers the rest.
//
// THE INVARIANT EVERYTHING HERE PROTECTS: the per-payer figures always sum to the
// family figure. The family balance formula is untouched — a split is a derived
// view on top of it — so the moment the two disagree, one of the numbers on
// somebody's statement is a lie.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const P = require(path.join(__dirname, '..', 'campistry_payers.js'));

const FAM = 'hh_stein';

// ── the registry ───────────────────────────────────────────────────────────

test('the registry survives whatever is in the blob', () => {
    const reg = P.normalize({
        hh_a: { name: 'Stein', kind: 'household', familyKey: 'fam_stein' },
        org_t: { name: 'Tomchei Fund', kind: 'organization', note: 'ref #4471' },
        '': { name: 'no id' },
        junk: null,
        weird: { name: 'X', kind: 'spaceship' }
    });
    assert.deepStrictEqual(Object.keys(reg).sort(), ['hh_a', 'org_t', 'weird']);
    assert.strictEqual(reg.org_t.note, 'ref #4471');
    assert.strictEqual(reg.weird.kind, 'household',
        'an unknown kind must become the kind that needs no special handling');
    assert.strictEqual(reg.hh_a.familyKey, 'fam_stein');
});

test('a payer with no name falls back to its id, not to blank', () => {
    const reg = P.normalize({ org_x: { kind: 'organization' } });
    assert.strictEqual(reg.org_x.name, 'org_x');
});

test('ids are safe as object keys and say which kind they are', () => {
    assert.strictEqual(P.idFor('Tomchei Shabbos', 'organization'), 'org_tomchei_shabbos');
    assert.strictEqual(P.idFor('The Steins', 'household'), 'hh_the_steins');
    assert.ok(!/[^a-z0-9_]/.test(P.idFor('Ünïcode / slashes: yes!', 'organization')));
});

// ── the allocation invariant ───────────────────────────────────────────────

test('shares ALWAYS sum to the charge, to the cent', () => {
    const cases = [
        [100, [{ payerId: 'org_t', amount: 800 }]],                 // over-allocated
        [1000, [{ payerId: 'org_t', amount: 800 }]],
        [1000, [{ payerId: 'hh_b', pct: 50 }]],
        [100, [{ payerId: 'a', pct: 33.33 }, { payerId: 'b', pct: 33.33 },
               { payerId: 'c', pct: 33.33 }]],
        [1000, [{ payerId: 'org_t', amount: 800 }, { payerId: 'hh_b', pct: 10 }]],
        [0, []],
        [1234.56, [{ payerId: 'x', pct: 37 }]],
        [0.01, [{ payerId: 'x', pct: 50 }]],
        [999.99, [{ payerId: 'a', pct: 1 }, { payerId: 'b', pct: 99 }]]
    ];
    cases.forEach(([total, shares]) => {
        const alloc = P.allocate(total, shares, FAM);
        const sum = alloc.reduce((n, a) => n + a.cents, 0);
        assert.strictEqual(sum, P.cents(total),
            'total ' + total + ' split ' + JSON.stringify(shares)
            + ' summed to ' + sum + ' not ' + P.cents(total));
    });
});

test('the rounding remainder is the household’s, never nobody’s', () => {
    // Three payers at 33.33% of $100 come to $99.99. The missing cent has to land
    // somewhere, and the household is the only payer that is always present.
    const alloc = P.allocate(100, [
        { payerId: 'a', pct: 33.33 }, { payerId: 'b', pct: 33.33 }, { payerId: 'c', pct: 33.33 }
    ], FAM);
    const rem = alloc.filter(a => a.basis === 'remainder');
    assert.strictEqual(rem.length, 1);
    assert.strictEqual(rem[0].payerId, FAM);
    assert.strictEqual(rem[0].cents, 1, 'the odd cent belongs to the household');
});

test('a typed amount is a commitment; a percentage is of the WHOLE bill', () => {
    // The fund approved $800. The other parent agreed to 10% of the bill. On a
    // $1000 charge that is 800 + 100, household 100 — not 800 then 10% of what is
    // left, which would put "10%" on a statement meaning something else.
    const alloc = P.allocate(1000, [
        { payerId: 'org_t', amount: 800, note: 'approved 2026-03-14' },
        { payerId: 'hh_b', pct: 10 }
    ], FAM);
    const by = {};
    alloc.forEach(a => { by[a.payerId] = a.cents; });
    assert.strictEqual(by.org_t, 80000);
    assert.strictEqual(by.hh_b, 10000, '10% must be 10% of the charge, not of the remainder');
    assert.strictEqual(by[FAM], 10000);
});

test('an amount beats a percentage for the same payer, rather than stacking', () => {
    const alloc = P.allocate(1000, [{ payerId: 'org_t', amount: 800, pct: 50 }], FAM);
    const org = alloc.filter(a => a.payerId === 'org_t');
    assert.strictEqual(org.length, 1, 'one line, not two');
    assert.strictEqual(org[0].cents, 80000);
});

test('the note rides along, because that is the point of organizations', () => {
    const alloc = P.allocate(1000, [
        { payerId: 'org_t', amount: 800, note: 'Tomchei Fund ref #4471' }
    ], FAM);
    assert.strictEqual(alloc[0].note, 'Tomchei Fund ref #4471');
});

test('an unsplit charge produces one line for the household', () => {
    // Every charge written before this feature existed. It must behave as it did.
    const alloc = P.allocate(500, null, FAM);
    assert.strictEqual(alloc.length, 1);
    assert.strictEqual(alloc[0].payerId, FAM);
    assert.strictEqual(alloc[0].cents, 50000);
    assert.strictEqual(alloc[0].basis, 'remainder');
});

test('a zero charge still produces a line, not an empty split', () => {
    const alloc = P.allocate(0, [], FAM);
    assert.strictEqual(alloc.length, 1);
    assert.strictEqual(alloc[0].cents, 0);
});

// ── refusing the impossible ────────────────────────────────────────────────

test('over-allocation is reported, with the figures', () => {
    const v = P.validate(1000, [{ payerId: 'a', amount: 800 }, { payerId: 'b', amount: 400 }]);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, 'over_allocated');
    assert.strictEqual(v.overC, 20000);
    assert.match(v.message, /1200\.00/);
    assert.match(v.message, /1000\.00/);
    assert.match(v.message, /200\.00 too much/);
});

test('under-allocation is NOT an error — it is the normal case', () => {
    const v = P.validate(1000, [{ payerId: 'org_t', amount: 800 }]);
    assert.strictEqual(v.ok, true, 'the household absorbing the rest is ordinary');
});

test('a negative share is refused, and told where credits go', () => {
    ['amount', 'pct'].forEach(k => {
        const v = P.validate(1000, [{ payerId: 'a', [k]: -50 }]);
        assert.strictEqual(v.ok, false, k);
        assert.strictEqual(v.reason, 'negative_share');
        assert.match(v.message, /credit against the charge/i);
    });
});

test('percentages over 100 are caught as over-allocation', () => {
    const v = P.validate(1000, [{ payerId: 'a', pct: 60 }, { payerId: 'b', pct: 60 }]);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, 'over_allocated');
});

// ── the per-payer view, against the family total ───────────────────────────

const LEDGER = [
    { type: 'charge', amount: 1000, payers: [
        { payerId: 'org_t', amount: 800, note: 'fund' }] },     // org 800, hh 200
    { type: 'charge', amount: 200 },                             // hh 200
    { type: 'credit', amount: 50 },                              // hh -50
    { type: 'payment', amount: 300 },                            // hh paid 300
    { type: 'payment', amount: 800, payerId: 'org_t' }           // org paid 800
];

test('the per-payer balances sum to the family balance, exactly', () => {
    // The whole safety property. The family formula is
    //   Σ charges + Σ refunds − Σ credits − Σ payments
    // = 1200 + 0 − 50 − 1100 = 50
    const famBalance = 1000 + 200 - 50 - 300 - 800;
    const r = P.balances({ entries: LEDGER, defaultPayerId: FAM });
    assert.strictEqual(r.total, famBalance,
        'the split view and the family view must agree about what is owed');
});

test('and it says who owes it', () => {
    const r = P.balances({ entries: LEDGER, defaultPayerId: FAM });
    // Organization: charged 800, paid 800 → square.
    assert.strictEqual(r.byPayer.org_t.balance, 0);
    // Household: 200 + 200 − 50 charged, 300 paid → 50 owing.
    assert.strictEqual(r.byPayer[FAM].balance, 50);
});

test('a payment with no payer belongs to the household', () => {
    // Because before this feature existed, every payment did.
    const r = P.balances({
        entries: [{ type: 'charge', amount: 100 }, { type: 'payment', amount: 40 }],
        defaultPayerId: FAM
    });
    assert.strictEqual(r.byPayer[FAM].paid, 40);
    assert.strictEqual(r.byPayer[FAM].balance, 60);
});

test('a refund takes money back from whoever paid it', () => {
    const r = P.balances({
        entries: [
            { type: 'charge', amount: 1000, payers: [{ payerId: 'org_t', amount: 800 }] },
            { type: 'payment', amount: 800, payerId: 'org_t' },
            { type: 'refund', amount: 300, payerId: 'org_t' }
        ],
        defaultPayerId: FAM
    });
    // The fund paid 800 and got 300 back, so it has covered 500 of its 800 share.
    assert.strictEqual(r.byPayer.org_t.paid, 500);
    assert.strictEqual(r.byPayer.org_t.balance, 300);
});

test('a credit can be split too, when it says so', () => {
    const r = P.balances({
        entries: [
            { type: 'charge', amount: 1000, payers: [{ payerId: 'org_t', pct: 50 }] },
            { type: 'credit', amount: 100, payers: [{ payerId: 'org_t', pct: 50 }] }
        ],
        defaultPayerId: FAM
    });
    assert.strictEqual(r.byPayer.org_t.charged, 450, '500 charged less 50 credited');
    assert.strictEqual(r.byPayer[FAM].charged, 450);
    assert.strictEqual(r.total, 900, 'and the family total is still charges less credits');
});

test('an empty ledger is zero, not a crash', () => {
    const r = P.balances({});
    assert.strictEqual(r.total, 0);
    assert.deepStrictEqual(r.byPayer, {});
});

test('a ledger full of rubbish does not throw', () => {
    const r = P.balances({ entries: [null, 'x', 42, {}, { type: 'charge' },
                                     { type: 'nonsense', amount: 5 }] });
    assert.strictEqual(typeof r.total, 'number');
});

// ── the one-liner for a statement ──────────────────────────────────────────

test('describe says who pays what, and nothing when there is one payer', () => {
    const reg = { org_t: { name: 'Tomchei Fund', kind: 'organization' },
                  hh_stein: { name: 'Stein', kind: 'household' } };
    const s = P.describe(1000, [{ payerId: 'org_t', amount: 800, note: 'ref #4471' }], reg, FAM);
    assert.match(s, /Tomchei Fund 800\.00 \(ref #4471\)/);
    assert.match(s, /Stein 200\.00/);
    // One payer is not a split, and a statement should not say it is.
    assert.strictEqual(P.describe(1000, [], reg, FAM), '');
    assert.strictEqual(P.describe(1000, null, reg, FAM), '');
});

test('describe does not invent a name for an unknown payer', () => {
    const s = P.describe(1000, [{ payerId: 'ghost', amount: 400 }], {}, FAM);
    assert.match(s, /Household 400\.00/, 'an unknown payer reads as the household');
});

// ── money arithmetic ───────────────────────────────────────────────────────

test('cents never produce a float surprise', () => {
    assert.strictEqual(P.cents(0.1 + 0.2), 30);
    assert.strictEqual(P.cents('19.99'), 1999);
    assert.strictEqual(P.cents(null), 0);
    assert.strictEqual(P.cents('abc'), 0);
    assert.strictEqual(P.cents(undefined), 0);
    assert.strictEqual(P.dollars(1999), 19.99);
});
