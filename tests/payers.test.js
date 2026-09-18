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

// ───────────────────────────────────────────────────────────────────────────
// THE WIRING. The rule above is useless until a charge can carry a split, the
// registry survives a save, and the ledger passes it through.
// ───────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
const MEHTML = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.html'), 'utf8');

test('the registry is loaded, normalized, and saved', () => {
    assert.match(ME, /payers=\(window\.CampistryPayers\?window\.CampistryPayers\.normalize\(me\.payers\)/,
        'normalized on the way in, so a hand-edited blob cannot break a render');
    assert.match(ME, /payers:_savedPayers,/, 'and written back out');
});

test('an empty registry can never wipe a populated one', () => {
    // The exact bug the sessions guard exists for: save() fires from an unrelated
    // edit before loadData() has hydrated, and an empty in-memory copy overwrites
    // every organization the camp set up.
    assert.match(ME, /var _savedPayers=\(payers&&Object\.keys\(payers\)\.length\)\?payers/);
    assert.match(ME, /:\(\(g\.campistryMe&&g\.campistryMe\.payers\)\|\|payers\);/);
});

test('a charge stores a split ONLY when there is one', () => {
    // An ordinary charge must be byte-identical to one written before this feature,
    // or every existing ledger row starts differing from every new one.
    assert.match(ME, /if\(_shares\.length\)_chg\.payers=_shares;/);
    const fn = ME.slice(ME.indexOf('function addChargeForFamily'));
    assert.ok(!/payers:_shares/.test(fn.slice(0, 4000)),
        'the split must not be written unconditionally into the charge literal');
});

test('an over-allocated split is refused before the charge is written', () => {
    const fn = ME.slice(ME.indexOf('function addChargeForFamily'));
    const body = fn.slice(0, 5000);

    // The shares must actually be READ FROM THE FORM. Asserting only that a
    // validate() call appears somewhere passes happily on a version where _shares
    // is hardcoded empty and the whole block is unreachable — which is how a
    // mutation that disabled validation entirely stayed green.
    assert.match(body, /var _P=_payersAPI\(\), _shares=_P\?_payerSharesFromForm\(\):\[\];/,
        'the split has to come from the form, not from a constant');

    assert.match(body, /var _v=_P\.validate\(amt,_shares\);/);
    assert.match(body, /if\(!_v\.ok\)\{toast\(_v\.message,'error'\);return\}/);
    // And before the push, or a refused split still lands on the ledger.
    assert.ok(body.indexOf('_P.validate(amt,_shares)') < body.indexOf('f.charges.push'),
        'validation must precede the write');
});

test('the ledger carries the split through to the derived entries', () => {
    // Derived from the ledger rather than re-read from families, so the per-payer
    // view and the family view cannot come from two different places.
    assert.match(ME, /payers:ch\.payers\|\|null\}\);/);
});

test('managing payers is gated like every other money action', () => {
    ['function managePayers()', 'function togglePayerArchived(id)'].forEach(sig => {
        const fn = ME.slice(ME.indexOf(sig));
        assert.match(fn.slice(0, 300), /_secEdit\('billing'/,
            sig + ' must be gated — it is money, and live-only inside a plan');
    });
});

test('a payer is archived, never deleted', () => {
    // A payer named on a past charge has to keep resolving to a name, or last
    // season's statements stop making sense.
    const fn = ME.slice(ME.indexOf('function togglePayerArchived(id)'));
    assert.match(fn.slice(0, 400), /payers\[id\]\.archived=!payers\[id\]\.archived/);
    assert.ok(!/delete payers\[/.test(ME), 'nothing may delete a payer outright');
});

test('a repeated payer name is refused, not silently merged', () => {
    const fn = ME.slice(ME.indexOf('function managePayers()'));
    assert.match(fn, /if\(payers\[id\]\)\{toast\('A payer called that already exists','error'\);return\}/);
});

test('an archived payer is not offered on a new charge', () => {
    const fn = ME.slice(ME.indexOf('function _payerOptions(famKey,selected)'));
    assert.match(fn.slice(0, 900), /if\(p\.archived\)return;/);
    // And the household is always there, always first, always the default.
    assert.match(fn.slice(0, 900), /\(household\)</);
    assert.match(fn.slice(0, 900), /\(!selected\|\|selected===famKey\)\?' selected':''/);
});

test('the household is never listed twice', () => {
    // It is rendered explicitly as the first option; a registry entry sharing its
    // key would otherwise appear again and split a charge with itself.
    const fn = ME.slice(ME.indexOf('function _payerOptions(famKey,selected)'));
    assert.match(fn.slice(0, 900), /if\(id===famKey\)return;/);
});

test('the module is loaded before the page that uses it', () => {
    // Compared as SCRIPT TAGS, not raw indexOf. The page mentions campistry_me.js
    // in a comment near the top ("Hidden by campistry_me.js"), so a plain string
    // search finds the prose and reports the order backwards.
    const tags = [...MEHTML.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]);
    const iPay = tags.indexOf('campistry_payers.js');
    const iMe = tags.indexOf('campistry_me.js');
    assert.ok(iPay >= 0, 'campistry_payers.js must be loaded');
    assert.ok(iMe >= 0, 'campistry_me.js must be loaded');
    assert.ok(iPay < iMe,
        'the rule must load before the page that asks it to validate a split');
});

test('there is a way in from Billing', () => {
    assert.match(ME, /CampistryMe\.managePayers\(\)/);
    assert.match(ME, /managePayers:managePayers,/, 'and it is exported');
    assert.match(ME, /_addPayerRow:_addPayerRow,_payerSplitPreview:_payerSplitPreview,/);
});
