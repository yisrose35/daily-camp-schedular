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

// ───────────────────────────────────────────────────────────────────────────
// AND IT APPLIES EVERYWHERE.
//
// The catalogue governed every till except the shop, which kept its own hard-coded
// list — the exact drift this module was written to end. Luggage recorded a `paid`
// tick with no method at all, despite the catalogue having always described luggage
// methods. And the setting itself was only reachable by editing a registration form.
// ───────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const SHOP_CORE = fs.readFileSync(path.join(__dirname, '..', 'campistry_shop_core.js'), 'utf8');
const SHOP_UI = fs.readFileSync(path.join(__dirname, '..', 'campistry_snacks_shop.js'), 'utf8');
const LUGGAGE = fs.readFileSync(path.join(__dirname, '..', 'campistry_go_luggage.js'), 'utf8');
const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');

/**
 * Load campistry_shop_core.js with a chosen `window`, and hand back its export.
 *
 * BEHAVIOURAL, because source matching cannot tell this apart: asserting that
 * `P.forContext('shop')` appears in the file passes just as happily when the branch
 * around it is `if (false)`, which is exactly how a mutation disabling the whole
 * lookup stayed green.
 */
/** Ids as a string. Arrays built INSIDE the vm carry the sandbox's Array.prototype,
 *  so deepStrictEqual fails on the prototype rather than the contents — and reports
 *  it as a content mismatch, which sends you looking in the wrong place. */
function ids(list) { return Array.prototype.map.call(list, m => m.id).join(','); }

function loadShopCore(fakeWindow) {
    const vm = require('node:vm');
    const sandbox = { module: { exports: {} }, console };
    sandbox.window = fakeWindow === undefined ? sandbox : fakeWindow;
    vm.runInContext(SHOP_CORE, vm.createContext(sandbox));
    return sandbox.module.exports;
}

test('the shop takes its methods FROM the catalogue', () => {
    const stub = {
        CampistryPayments: {
            forContext: ctx => (ctx === 'shop'
                ? [{ id: 'zelle', label: 'Zelle' }, { id: 'bill', label: 'Charge to camp bill' }]
                : [])
        }
    };
    const S = loadShopCore(stub);
    assert.strictEqual(ids(S.payMethods()), 'zelle,bill',
        'the shop must offer what the camp accepts, not a list of its own');
    // Asked for EACH TIME, so a policy change in another tab does not need a reload.
    stub.CampistryPayments.forContext = () => [{ id: 'cash', label: 'Cash' }];
    assert.strictEqual(ids(S.payMethods()), 'cash');
});

test('a page without the catalogue behaves exactly as the shop always did', () => {
    const S = loadShopCore({});
    assert.strictEqual(ids(S.payMethods()), 'credit,cash,check,canteen,bill',
        'the fallback must be the original five, not the opened-up catalogue');
});

test('an empty catalogue answer falls back rather than offering nothing', () => {
    const S = loadShopCore({ CampistryPayments: { forContext: () => [] } });
    assert.ok(S.payMethods().length > 0, 'a till with no payment methods cannot sell');
});

test('the shop no longer declares a catalogue of its own', () => {
    assert.match(SHOP_CORE, /var FALLBACK_PAY_METHODS = \[/);
    assert.ok(!/S\.PAY_METHODS = \[/.test(SHOP_CORE),
        'the literal must be a fallback, not the source of truth');
    // The OPTION LIST specifically must come from the getter. Anchored on the exact
    // expression, because `SC.payMethods()` also appears elsewhere on the same line
    // and matching the bare name passed with the option list switched back.
    assert.match(SHOP_UI, /SC\.payMethods\(\)\.concat\(/);
});

test('a method the camp dropped still reads correctly on an old order', () => {
    // Otherwise editing last season's order silently clears how it was paid, and the
    // order history renders raw ids.
    assert.match(SHOP_UI, /no longer accepted/);
    const fn = SHOP_UI.slice(SHOP_UI.indexOf('function payLabel(id)'));
    assert.match(fn.slice(0, 800), /P\.label/,
        'the label resolver must span every method, not just the accepted ones');
});

test('luggage records HOW a booking was paid, from the catalogue', () => {
    assert.match(LUGGAGE, /function lugPayMethods\(\)/);
    assert.match(LUGGAGE, /P\.forContext\('luggage'\)/);
    assert.match(LUGGAGE, /id="bkPayMethod"/, 'the form needs the field');
    assert.match(LUGGAGE, /payMethod: val\('bkPayMethod'\),/, 'and the save must keep it');
    assert.match(LUGGAGE, /no longer accepted/);
});

test('both pages load the catalogue before the code that asks it', () => {
    [['campistry_snacks.html', 'campistry_snacks_shop.js'],
     ['campistry_go.html', 'campistry_go_luggage.js']].forEach(([page, consumer]) => {
        const src = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
        const tags = [...src.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]);
        const iCat = tags.indexOf('campistry_payments.js');
        const iUse = tags.indexOf(consumer);
        assert.ok(iCat >= 0, page + ' must load the catalogue');
        assert.ok(iUse >= 0, page + ' must load ' + consumer);
        assert.ok(iCat < iUse, page + ': the catalogue must load first');
    });
});

test('the setting has a home of its own, not a corner of the form builder', () => {
    assert.match(ME, /function managePaymentMethods\(\)/);
    assert.match(ME, /managePaymentMethods:managePaymentMethods,/, 'exported');
    assert.match(ME, /CampistryMe\.managePaymentMethods\(\)/, 'and reachable from Billing');
    const fn = ME.slice(ME.indexOf('function managePaymentMethods()'));
    const body = fn.slice(0, 3000);
    assert.match(body, /_secEdit\('billing'/, 'gated like every other money action');
    // It must cover every context the catalogue knows, or a till goes ungoverned.
    assert.match(body, /\(P\.CONTEXTS\|\|\[\]\)\.forEach/);
    // No stored list means everything is on — the open default stated, not implied.
    assert.match(body, /var on=enabled\?\(enabled\.indexOf\(m\.id\)>=0\):true;/);
    // And it refuses to leave a camp unable to take money at all.
    assert.match(body, /Keep at least one payment method/);
});
