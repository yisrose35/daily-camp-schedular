// node --test tests/processor_facing_parent.test.js
//
// The two things that go wrong between a camp's software and its processor
// that the parent sees, taken from what camps and their families actually
// report about this category of software.
//
//   1. THE CHARGE THE PARENT CANNOT PLACE. Every Stripe charge here is created
//      on the PLATFORM account with transfer_data[destination] pointing at the
//      camp. A destination charge without on_behalf_of settles on the platform,
//      so the cardholder's statement carries the PLATFORM's descriptor — a
//      company the parent has never heard of, for money they gave their camp.
//      An unrecognised descriptor is the single most documented avoidable
//      chargeback there is, and "Campistry payment" as the description made it
//      worse. Stripe: "Charges created with on_behalf_of now use the descriptor
//      of the connected account instead of the platform's statement descriptor."
//
//   2. THE REFUND THAT FAILS AT THE COUNTER. A card refund settles against the
//      original authorisation and that link expires — processors cluster around
//      four months. The refund draw was oldest-first, which aimed every refund
//      at exactly the charges most likely to be rejected.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
// Whole-line comments are prose, not behaviour: a rule stated in a comment
// must never satisfy — or violate — an assertion about the code.
const code = p => read(p).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const ME = read('campistry_me.js');

// ── 1. every destination charge names the camp as the merchant ──────────────

const DESTINATION_CHARGE_FNS = [
    ['supabase/functions/stripe-charge/index.ts', 'on_behalf_of'],
    ['supabase/functions/charge-saved-card/index.ts', 'on_behalf_of'],
    ['supabase/functions/canteen-auto-reload/index.ts', 'on_behalf_of'],
    ['supabase/functions/charge-due-installments/index.ts', 'on_behalf_of'],
    ['supabase/functions/stripe-checkout/index.ts', 'payment_intent_data[on_behalf_of]'],
];

test('every function that sets transfer_data[destination] also sets on_behalf_of', () => {
    DESTINATION_CHARGE_FNS.forEach(([file, param]) => {
        const src = read(file);
        assert.ok(src.includes(param), file + ' never sets ' + param);
    });
});

test('no destination charge is left anywhere without on_behalf_of beside it', () => {
    // A new charge path that copies transfer_data and forgets on_behalf_of is
    // the regression this guards: it is invisible until a parent disputes.
    const files = [];
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else if (d.name.endsWith('.ts')) files.push(full);
    });
    walk(path.join(ROOT, 'supabase', 'functions'));
    const offenders = files.filter(f => {
        const src = fs.readFileSync(f, 'utf8');
        // Only count real assignments, not the explanatory comments.
        const sets = src.split('\n').filter(l =>
            /params\[[^\]]*transfer_data[^\]]*\]\s*=/.test(l) && !/^\s*\/\//.test(l));
        if (!sets.length) return false;
        return !/on_behalf_of/.test(src);
    });
    assert.deepStrictEqual(offenders.map(f => path.relative(ROOT, f)), []);
});

test('on_behalf_of is always the destination account, never a different one', () => {
    // Stripe rejects a card payment whose on_behalf_of differs from
    // transfer_data[destination], so they must come from one value.
    DESTINATION_CHARGE_FNS.forEach(([file]) => {
        const src = read(file);
        const lines = src.split('\n').filter(l => /on_behalf_of/.test(l) && /=/.test(l) && !/^\s*\/\//.test(l));
        assert.ok(lines.length > 0, file);
        lines.forEach(l => {
            assert.match(l, /destinationAccountId/,
                file + ': on_behalf_of must be the destination account — ' + l.trim());
        });
    });
});

test('no charge is described to a parent as "Campistry payment"', () => {
    DESTINATION_CHARGE_FNS.forEach(([file]) => {
        const src = code(file);
        assert.ok(!/["'`]Campistry payment["'`]/.test(src),
            file + ' still describes a parent-facing charge as Campistry');
    });
});

test('each charge description carries the camp’s own name', () => {
    assert.match(code('supabase/functions/stripe-charge/index.ts'),
        /camp\.name \+ " — payment"/, 'stripe-charge must describe the charge with the camp name');
    assert.match(read('supabase/functions/charge-saved-card/index.ts'),
        /campLabel/, 'charge-saved-card must label with the camp');
    ['charge-due-installments', 'canteen-auto-reload'].forEach(fn => {
        assert.match(read('supabase/functions/' + fn + '/index.ts'), /campNames\.get\(/,
            fn + ' must label the charge with the camp name');
    });
    assert.match(read('supabase/functions/stripe-checkout/index.ts'), /campLabel \|\| "Camp"/);
});

test('the camp-name lookup selects the name it needs', () => {
    ['charge-due-installments', 'canteen-auto-reload', 'charge-saved-card', 'stripe-charge'].forEach(fn => {
        const src = read('supabase/functions/' + fn + '/index.ts');
        const selects = src.split('\n').filter(l => /\.select\(/.test(l) && /stripe_account_id/.test(l));
        assert.ok(selects.length > 0, fn);
        selects.forEach(l => assert.match(l, /name/,
            fn + ': the camp select must include name, or the label falls back to "Camp" — ' + l.trim()));
    });
});

test('a missing camp name never stops a payment', () => {
    // The name is for the parent's benefit; failing a charge over it would
    // trade a chargeback risk for lost revenue.
    const co = read('supabase/functions/stripe-checkout/index.ts');
    assert.match(co, /catch \(_\) \{ \/\* a missing name must never stop a payment \*\/ \}/);
    assert.match(co, /const who = campLabel \|\| "Camp"/);
});

// ── 2. the refund window ───────────────────────────────────────────────────

test('there is a refund window, and it is conservative', () => {
    assert.match(ME, /var REFUND_WINDOW_DAYS=120;/);
    assert.match(ME, /var REFUND_WINDOW_WARN_DAYS=100;/);
});

test('the gateway refund pool draws NEWEST first, not oldest', () => {
    const fn = ME.slice(ME.indexOf('function _famRefundableOnlineAll'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /return tb-ta;/, 'oldest-first aims every refund at the charges most likely to be rejected');
    assert.ok(!/return ta-tb;/.test(body));
});

test('payments past the window are out of the pool, not silently attempted', () => {
    const fn = ME.slice(ME.indexOf('function _famRefundableOnline(f)'));
    const body = fn.slice(0, fn.indexOf('\nfunction _famRefundableOnlineAll'));
    assert.match(body, /age<=REFUND_WINDOW_DAYS/);
});

test('expired money is reported with what to do instead', () => {
    assert.match(ME, /function _famRefundExpired\(f\)/);
    const sum = ME.slice(ME.indexOf('function _crUpdateRefundSummary'));
    const body = sum.slice(0, sum.indexOf('function _crUpdateBalancePreview'));
    assert.match(body, /_famRefundExpired\(f\)/, 'the dialog must say what is out of reach');
    assert.match(body, /Offline Refund/, 'and name the alternative');
    assert.match(body, /REFUND_WINDOW_WARN_DAYS/, 'and warn before it becomes the problem');
});

test('an all-expired family is not told they have no online charges', () => {
    // That message was true of the pool and false of the family, and it sends
    // the office looking for a payment record that is right there.
    const sum = ME.slice(ME.indexOf('function _crUpdateRefundSummary'));
    const body = sum.slice(0, sum.indexOf('function _crUpdateBalancePreview'));
    const noCharges = body.indexOf('No online charges on record');
    assert.ok(noCharges > 0);
    assert.match(body.slice(0, noCharges).slice(-600), /expiredTotal0>0/,
        'the no-charges message must be the else of an expired-money check');
});

test('the submit path refuses an over-window refund with the real reason', () => {
    const i = ME.indexOf("if(onlineTotal<=0){");
    assert.ok(i > 0);
    const block = ME.slice(i, i + 700);
    assert.match(block, /_famRefundExpired\(f\)/);
    assert.match(block, /older than '\+REFUND_WINDOW_DAYS\+' days/);
});

test('an undated payment is not treated as expired', () => {
    // A payment with no date cannot be aged. Excluding it would silently drop
    // refundable money out of the pool; the age check returns null for it.
    const fn = ME.slice(ME.indexOf('function _paymentAgeDays'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /if\(!t\|\|!isFinite\(t\)\)return null;/);
    const pool = ME.slice(ME.indexOf('function _famRefundableOnline(f)'));
    assert.match(pool.slice(0, 400), /age==null\|\|age<=REFUND_WINDOW_DAYS/);
});

test('applying a payment to charges still runs oldest-first', () => {
    // The two directions are deliberately opposite. If the tax statement's
    // FIFO ever flipped to match the refund draw, every per-child figure on a
    // year-end statement would change.
    const TS = require(path.join(ROOT, 'campistry_tax_statement.js'));
    const r = TS.build({
        year: 2026,
        entries: [
            { type: 'charge', category: 'Tuition', amount: 1000, date: '2026-01-01', ref: 'a' },
            { type: 'charge', category: 'Tuition', amount: 1000, date: '2026-06-01', ref: 'b' },
            { type: 'payment', amount: 1000, date: '2026-07-01' }
        ],
        resolveCharge: e => ({ camperName: e.ref === 'a' ? 'Older' : 'Newer' })
    });
    assert.deepStrictEqual(r.byCamper.map(b => b.camperName), ['Older']);
});
