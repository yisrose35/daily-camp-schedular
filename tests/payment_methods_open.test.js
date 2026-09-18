// node --test tests/payment_methods_open.test.js
//
// NOTHING IS WITHHELD BY DEFAULT. Every method in the catalogue is available out of
// the box and the camp turns off what it does not take.
//
// This reverses how the file started. Debit was refused by default, on reasoning
// that is still true — tuition on debit leaves the camp carrying chargeback and NSF
// exposure without the protections a credit card gives either side, and debit rails
// do not carry installment plans. But that is a BUSINESS judgement, and a camp that
// wanted debit had to ask a developer to change a default.
//
// The blocking MECHANISM stays, because a refused method shown struck through reads
// as a decision while an absent one reads as an oversight somebody re-adds in six
// months. Only the default changed.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const P = require(path.join(__dirname, '..', 'campistry_payments.js'));

test('nothing at all is blocked out of the box', () => {
    assert.deepStrictEqual(P.BLOCKED, [], 'the blocked list starts empty');
    P.CONTEXTS.forEach(ctx =>
        assert.deepStrictEqual(P.blockedFor(ctx), [], 'nothing blocked in ' + ctx));
});

test('no method is withheld by its own default either', () => {
    // default:false was the other way a method went missing — not refused, just not
    // offered until somebody found the setting. Same outcome for a camp.
    P.METHODS.forEach(m =>
        assert.strictEqual(m.default, true,
            m.id + ' must be offered by default; a camp turns off what it does not take'));
});

test('debit is an ordinary catalogue method now', () => {
    const d = P.method('debit');
    assert.ok(d, 'debit must be in the catalogue, not a special case');
    assert.strictEqual(d.default, true);
    ['tuition', 'canteen', 'shop', 'luggage'].forEach(ctx =>
        assert.ok(d.contexts.includes(ctx), 'debit should be available for ' + ctx));
    assert.strictEqual(P.label('debit'), 'Debit card');
});

test('debit appears exactly once, not twice', () => {
    // It used to be pushed in separately by forContext on top of the catalogue
    // filter, which would list it twice now that it is a normal entry.
    const ids = P.forContext('tuition').map(m => m.id);
    assert.strictEqual(ids.filter(id => id === 'debit').length, 1);
});

test('every context offers its full catalogue by default', () => {
    P.CONTEXTS.forEach(ctx => {
        const offered = P.forContext(ctx).map(m => m.id).sort();
        const possible = P.METHODS.filter(m => m.contexts.includes(ctx))
                                  .map(m => m.id).sort();
        assert.deepStrictEqual(offered, possible,
            ctx + ' must offer everything valid for it');
    });
});

// ── what the camp can still do ─────────────────────────────────────────────

test('a camp narrows the list to what it accepts', () => {
    const ids = P.forContext('tuition', { enabled: ['credit', 'cash', 'zelle'] }).map(m => m.id);
    assert.deepStrictEqual(ids, ['credit', 'cash', 'zelle']);
    assert.strictEqual(P.isAllowed('check', 'tuition', { enabled: ['credit'] }), false,
        'and the save path refuses what the picker did not offer');
});

test('a camp that turns debit off still gets told why', () => {
    // The refusal is theirs, so it reads as their decision rather than a gap.
    const ids = P.forContext('tuition', { allowDebit: false }).map(m => m.id);
    assert.ok(!ids.includes('debit'));
    const blocked = P.blockedFor('tuition', { allowDebit: false });
    assert.strictEqual(blocked.length, 1);
    assert.strictEqual(blocked[0].id, 'debit');
    assert.match(blocked[0].detail, /turned debit off/);
});

test('an existing stored policy that said no still means no', () => {
    // Back-compat: allowDebit was a real setting, and a camp that set it meant it.
    assert.ok(!P.forContext('shop', { allowDebit: false }).some(m => m.id === 'debit'));
    // But the ABSENCE of the setting no longer means no.
    assert.ok(P.forContext('shop', {}).some(m => m.id === 'debit'));
    assert.ok(P.forContext('shop', { allowDebit: true }).some(m => m.id === 'debit'));
});

test('a camp can refuse any method, not only debit', () => {
    // The mechanism is general — it was only ever pointed at one method.
    const saved = P.BLOCKED.slice();
    P.BLOCKED.push({ id: 'check', label: 'Check', reason: 'Not accepted',
                     detail: 'We stopped taking cheques.' });
    try {
        const blocked = P.blockedFor('tuition');
        assert.ok(blocked.some(b => b.id === 'check'));
    } finally {
        P.BLOCKED.length = 0;
        saved.forEach(b => P.BLOCKED.push(b));
    }
});

test('the header no longer argues for a default it does not have', () => {
    // Stale reasoning is worse than none: the next person reads it as the behaviour.
    const src = require('node:fs').readFileSync(
        path.join(__dirname, '..', 'campistry_payments.js'), 'utf8');
    assert.ok(!/WHY DEBIT IS BLOCKED/.test(src));
    assert.match(src, /NOTHING IS WITHHELD BY DEFAULT/);
    // And the tradeoff is still recorded, because it is still true.
    assert.match(src, /chargeback and NSF exposure/);
});
