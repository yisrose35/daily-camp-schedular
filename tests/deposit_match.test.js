// node --test tests/deposit_match.test.js
//
// This module can move money into a family ledger with no human involved, so
// the tests are weighted toward the cases where it must REFUSE to: an ambiguous
// tie, an overpayment, a reversal, dry-run. Auto-posting to the wrong family
// corrupts two ledgers and nobody notices until statements go out.
const test = require('node:test');
const assert = require('node:assert');
const M = require('../campistry_deposit_match.js');

// A small camp with the exact name problems this feature exists to solve:
// a business payer, a maiden name, and two households sharing a surname.
const families = {
    fam_klein:  { name: 'Klein Family',  parents: [{ name: 'Shimon Klein', email: 'shimon@kleinhome.com', phone: '(845) 555-0142' }] },
    fam_gold:   { name: 'Goldberg Family', parents: [{ name: 'Rivka Goldberg', email: 'rivka.g@gmail.com', phone: '8455559911' }] },
    fam_weiss:  { name: 'Weiss Family',  parents: [{ name: 'Miriam Weiss', email: 'mweiss@example.com' }] },
    fam_weiss2: { name: 'Weiss Family',  parents: [{ name: 'Dovid Weiss', email: 'dweiss@example.com' }] }
};

const ledgers = {
    fam_klein:  { balance: 850,  installments: [{ amount: 425 }] },
    fam_gold:   { balance: 3000 },
    fam_weiss:  { balance: 1200 },
    fam_weiss2: { balance: 1200 }
};

const ctx = over => Object.assign({ families, ledgers, aliases: [] }, over || {});

// ── memo codes ───────────────────────────────────────────────────────────────

test('memo codes are stable and self-validating', () => {
    const code = M.memoCode('fam_klein', 'Klein Family');
    assert.match(code, /^[A-Z]{3}-[0-9]{4}$/);
    assert.strictEqual(code, M.memoCode('fam_klein', 'Klein Family'));   // stable
    assert.ok(M.isValidMemoCode(code));
    assert.strictEqual(M.familyForMemoCode(code, families), 'fam_klein');
});

test('the check digit rejects stray reference numbers', () => {
    // Bank alerts are full of confirmation ids shaped like AAA-1234. Without the
    // check digit, one of those would credit a random family.
    let accepted = 0;
    for (let i = 0; i < 1000; i++) {
        if (M.isValidMemoCode('KLE-' + String(i).padStart(4, '0'))) accepted++;
    }
    assert.strictEqual(accepted, 100);              // exactly 1 in 10, as designed
    assert.strictEqual(M.familyForMemoCode('ZZZ-0000', families), null);
});

test('a memo code beats a conflicting payer name outright', () => {
    // The whole point: the business name says nothing, the code says everything.
    const d = {
        amount: 850, payerName: "SHIMON'S HARDWARE LLC",
        memoCode: M.memoCode('fam_klein', 'Klein Family'), kind: 'zelle'
    };
    const r = M.decide(d, ctx());
    assert.strictEqual(r.decision, 'auto');
    assert.strictEqual(r.familyKey, 'fam_klein');
    assert.strictEqual(r.confidence, 100);
});

// ── name normalization ───────────────────────────────────────────────────────

test('business suffixes normalize away in every spelling', () => {
    const want = 'shimons hardware';
    ["SHIMON'S HARDWARE LLC", 'Shimons Hardware, L.L.C.', 'SHIMONS HARDWARE L L C', 'Shimon’s Hardware Inc.']
        .forEach(v => assert.strictEqual(M.normalize(v), want, v));
});

test('name matching is order-independent and nickname-aware', () => {
    assert.strictEqual(M.nameSimilarity('SMITH JOHN', 'John Smith'), 1);
    assert.strictEqual(M.nameSimilarity('Bob Klein', 'Robert Klein'), 1);
    assert.ok(M.sharesSurname('ESTHER KLEIN', 'Klein Family'));
    assert.ok(M.sharesSurname('The Kleins', 'Klein Family'));
    assert.ok(!M.sharesSurname('Rivka Goldberg', 'Klein Family'));
});

test('phone handles compare regardless of formatting', () => {
    assert.strictEqual(M.normalizeHandle('(845) 555-0142'), M.normalizeHandle('+1 845 555 0142'));
});

// ── the alias loop: the fix for the maiden-name / business-name problem ──────

test('a learned alias auto-posts a payer whose name matches nothing', () => {
    const deposit = { amount: 400, payerName: 'MALKA SCHWARTZ', kind: 'zelle' };   // mother's maiden name

    // Before learning: nothing matches, so it waits for a human.
    assert.strictEqual(M.decide(deposit, ctx()).decision, 'unmatched');

    // The office resolves it once; that click produces an alias.
    const alias = M.aliasFrom(deposit, 'fam_klein', []);
    assert.strictEqual(alias.familyKey, 'fam_klein');
    assert.strictEqual(alias.normalized, 'malka schwartz');
    assert.strictEqual(alias.source, 'learned');

    // Every future payment from that name posts by itself.
    const after = M.decide(deposit, ctx({ aliases: [alias] }));
    assert.strictEqual(after.decision, 'auto');
    assert.strictEqual(after.familyKey, 'fam_klein');
});

test('an alias is not re-learned once it exists', () => {
    const deposit = { amount: 400, payerName: 'Malka  SCHWARTZ' };
    const existing = [{ familyKey: 'fam_klein', displayName: 'MALKA SCHWARTZ', normalized: 'malka schwartz' }];
    assert.strictEqual(M.aliasFrom(deposit, 'fam_klein', existing), null);
});

test('a Zelle handle already on file as a parent contact auto-posts', () => {
    const d = { amount: 3000, payerName: 'R GOLDBERG ENTERPRISES', payerHandle: 'rivka.g@gmail.com', kind: 'zelle' };
    const r = M.decide(d, ctx());
    assert.strictEqual(r.decision, 'auto');
    assert.strictEqual(r.familyKey, 'fam_gold');
});

// ── guardrails: the refusals ─────────────────────────────────────────────────

test('two households sharing a surname never auto-post', () => {
    // Weiss vs Weiss with identical balances -- exactly the tie that must stop.
    const r = M.decide({ amount: 1200, payerName: 'Weiss Family' }, ctx());
    assert.strictEqual(r.decision, 'review');
    assert.match(r.guardrail, /match about equally/);
    assert.strictEqual(r.familyKey, null);
});

test('a deposit larger than the balance never auto-posts', () => {
    const code = M.memoCode('fam_klein', 'Klein Family');
    const r = M.decide({ amount: 5000, payerName: 'Shimon Klein', memoCode: code }, ctx());
    assert.strictEqual(r.decision, 'review');
    assert.match(r.guardrail, /More than the Klein Family balance/);
});

test('a reversal always goes to a human', () => {
    const code = M.memoCode('fam_klein', 'Klein Family');
    assert.strictEqual(M.decide({ amount: -850, payerName: 'Shimon Klein', memoCode: code }, ctx()).decision, 'review');
    assert.strictEqual(M.decide({ amount: 850, isReversal: true, memoCode: code }, ctx()).decision, 'review');
});

test('dry run posts nothing but still ranks and explains', () => {
    const code = M.memoCode('fam_klein', 'Klein Family');
    const r = M.decide({ amount: 850, payerName: 'Shimon Klein', memoCode: code }, ctx(), { dryRun: true });
    assert.strictEqual(r.decision, 'review');
    assert.match(r.guardrail, /Dry run/);
    assert.strictEqual(r.candidates[0].familyKey, 'fam_klein');   // still shows the answer
});

test('an unreadable payer with no code stays unmatched rather than guessing', () => {
    const r = M.decide({ amount: 75, payerName: '' }, ctx());
    assert.strictEqual(r.decision, 'unmatched');
    assert.strictEqual(r.familyKey, null);
});

test('a weak surname-only match is suggested, never posted', () => {
    const r = M.decide({ amount: 500, payerName: 'ESTHER KLEIN' }, ctx());
    assert.strictEqual(r.decision, 'review');
    assert.strictEqual(r.candidates[0].familyKey, 'fam_klein');
    assert.ok(r.candidates[0].score < M.DEFAULTS.autoPostAt);
});

// ── explanations ─────────────────────────────────────────────────────────────

test('every candidate carries the reason it was chosen', () => {
    const code = M.memoCode('fam_klein', 'Klein Family');
    const r = M.decide({ amount: 850, payerName: "SHIMON'S HARDWARE LLC", memoCode: code }, ctx());
    assert.ok(r.candidates[0].reasons.some(x => x.indexOf('Memo code') === 0));
    assert.ok(r.candidates[0].reasons.some(x => /balance exactly/.test(x)));
    assert.strictEqual(r.candidates[0].familyName, 'Klein Family');
});
