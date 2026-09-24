// =============================================================================
// charges_reach_the_ledger.test.js — TED-053 and TED-062.
//
// Late fees, card surcharges, Add Charge, bulk charges and close-out entries
// were written to families[fk].charges only. Both balances (the office's and
// the parent's) come from the posted ledger once a family has one, so none of
// them was ever owed. Now each is posted to the ledger, once, keyed on its id —
// and every charge already on file is posted the next time Billing loads.
//
// The real _postLedgerCharge runs here against the real BillingCore.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ME = fs.readFileSync(path.join(ROOT, 'campistry_me.js'), 'utf8');
const B = require(path.join(ROOT, 'campistry_billing_core.js'));

function cut(name) {
    const at = ME.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name + ' is missing');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}
const ctx = { _billingCore: () => B };
vm.createContext(ctx);
vm.runInContext(cut('_postLedgerCharge') + '\n' + cut('_postExistingCharges') + '\nthis.post=_postLedgerCharge;this.catchUp=_postExistingCharges;', ctx);

function family() {
    // $1,000 tuition, $400 paid — a family with a posted ledger, as every
    // enrolled family has.
    const f = { name: 'Gold', entries: [] };
    B.post(f, { id: 'le_t1', kind: 'charge', amount: 1000, reason: 'tuition', note: 'Tuition' });
    B.post(f, { id: 'le_p1', kind: 'payment', amount: 400, reason: 'card', note: 'Payment' });
    return f;
}

test('TED-053: a $25 late fee raises the balance from $600 to $625', () => {
    const f = family();
    assert.strictEqual(B.balance(f), 600);
    f.charges = [{ id: 'lf_x', category: 'Late Fee', description: 'Late fee', amount: 25, date: '2026-07-01' }];
    assert.strictEqual(ctx.post(f, f.charges[0]), true);
    assert.strictEqual(B.balance(f), 625);
});

test('TED-053: posting the same charge again does nothing (a re-render cannot bill twice)', () => {
    const f = family();
    const c = { id: 'sur_1', category: 'Card Fee', amount: 12.34 };
    ctx.post(f, c); ctx.post(f, c); ctx.post(f, c);
    assert.strictEqual(B.balance(f), 612.34);
});

test('TED-053: every kind of charge reaches the ledger with a known reason', () => {
    const f = family();
    [{ id: 'lf_1', category: 'Late Fee', amount: 25 }, { id: 'sur_1', category: 'Card Fee', amount: 3 },
     { id: 'chg_1', category: 'Trip', amount: 50 }, { id: 'bchg_1_0', category: 'Other', amount: 10 },
     { id: 'co_1', category: 'Close-out', amount: 5 }].forEach(c => assert.ok(ctx.post(f, c), c.id + ' did not post'));
    assert.strictEqual(B.balance(f), 693);
    f.entries.filter(e => e.id.startsWith('le_chg_')).forEach(e => assert.ok(B.REASONS.includes(e.reason), e.reason));
});

test('a family with no ledger yet is left alone (its balance still comes from charges[])', () => {
    const f = { name: 'New', charges: [{ id: 'chg_2', amount: 50 }] };
    assert.strictEqual(ctx.post(f, f.charges[0]), false);
    assert.ok(!f.entries || !f.entries.length);
});

test('a zero or negative charge never posts', () => {
    const f = family();
    assert.strictEqual(ctx.post(f, { id: 'z', amount: 0 }), false);
    assert.strictEqual(ctx.post(f, { id: 'n', amount: -50 }), false);
    assert.strictEqual(B.balance(f), 600);
});

test('all five places that add a charge post it, and Billing posts old ones on load', () => {
    const n = (ME.match(/f\.charges\.push\([\s\S]{0,600}?_postLedgerCharge\(f,/g) || []).length;
    assert.strictEqual(n, 5, 'expected 5 charge writers to post to the ledger, found ' + n);
    assert.match(ME, /_posted\+=_postExistingCharges\(f\);/);
});

test('TED-062: Issue Credit and Add Charge refuse zero and negative amounts', () => {
    assert.match(ME, /var amt=Math\.round\(\(parseFloat\(document\.getElementById\('crAmount'\)\.value\)\|\|0\)\*100\)\/100;\s*\/\/[^\n]*\n[^\n]*\n\s*if\(!\(amt>0\)\)/);
    assert.match(ME, /var amt=Math\.round\(\(parseFloat\(document\.getElementById\('chgAmount'\)\.value\)\|\|0\)\*100\)\/100;\s*\/\/[^\n]*\n\s*if\(!\(amt>0\)\)/);
});

test('TED-065: on a camp that ran the ledger conversion, opening Billing does not post old charges twice', () => {
    // The conversion (171/215) wrote tuition, the payment AND the two charges
    // that existed then, as le_conv_ entries with nothing linking them to the
    // charge ids. $1000 + $25 + $10 - $400 = $635.
    const f = { name: 'Conv', entries: [
        { id: 'le_conv_f_1', kind: 'charge', amount: 1000, reason: 'tuition', source: { enrollmentId: 'e1' } },
        { id: 'le_conv_f_2', kind: 'charge', amount: 25, reason: 'fee', date: '2026-07-01', source: {} },
        { id: 'le_conv_f_3', kind: 'charge', amount: 10, reason: 'fee', date: '2026-07-02', source: {} },
        { id: 'le_conv_f_4', kind: 'payment', amount: 400, reason: 'card' }],
      charges: [{ id: 'lf_old', category: 'Late Fee', amount: 25, date: '2026-07-01' },
                { id: 'chg_old', category: 'Trip', amount: 10, date: '2026-07-02' }] };
    assert.strictEqual(B.balance(f), 635);
    assert.strictEqual(ctx.catchUp(f), 0, 'a converted charge was posted again');
    assert.strictEqual(ctx.catchUp(f), 0);
    assert.strictEqual(B.balance(f), 635);
    // a charge added AFTER the conversion is still posted, once
    f.charges.push({ id: 'lf_new', category: 'Late Fee', amount: 25, date: '2026-08-01' });
    assert.strictEqual(ctx.catchUp(f), 1);
    assert.strictEqual(ctx.catchUp(f), 0);
    assert.strictEqual(B.balance(f), 660);
});

test('TED-065: two same-amount charges against one converted entry — only one is covered', () => {
    const f = { name: 'Two', entries: [
        { id: 'le_conv_t_1', kind: 'charge', amount: 25, reason: 'fee', date: '2026-07-01', source: {} }],
      charges: [{ id: 'a', amount: 25, date: '2026-07-01' }, { id: 'b', amount: 25, date: '2026-07-15' }] };
    assert.strictEqual(ctx.catchUp(f), 1);
    assert.strictEqual(B.balance(f), 50);
});

test('TED-066: a charge that disappears (a cancelled shop order) comes off the ledger, once', () => {
    const f = family();
    f.charges = [{ id: 'shop_o1', category: 'Camp Shop', amount: 40 }];
    ctx.catchUp(f);
    assert.strictEqual(B.balance(f), 640);
    f.charges = [];                        // cancelled
    assert.strictEqual(ctx.catchUp(f), 1);
    assert.strictEqual(B.balance(f), 600);
    assert.strictEqual(ctx.catchUp(f), 0, 'the reversal posted again');
    assert.strictEqual(B.balance(f), 600);
});

test('TED-066: a re-priced charge moves the balance by the difference only', () => {
    const f = family();
    f.charges = [{ id: 'shop_o2', category: 'Camp Shop', amount: 40 }];
    ctx.catchUp(f);
    f.charges[0].amount = 55;
    ctx.catchUp(f); ctx.catchUp(f);
    assert.strictEqual(B.balance(f), 655);
    f.charges[0].amount = 30;
    ctx.catchUp(f);
    assert.strictEqual(B.balance(f), 630);
});

test('TED-066: the database already took a cancelled charge off — the Me page adds nothing', () => {
    // what migration 263's _sync_charge_to_ledger leaves behind
    const f = family();
    f.entries.push({ id: 'le_chg_shop_o3', kind: 'charge', amount: 40, reason: 'fee', source: { chargeId: 'shop_o3' } });
    f.entries.push({ id: 'le_chgadj_shop_o3_1', kind: 'credit', amount: 40, reason: 'reversal', source: { chargeId: 'shop_o3' } });
    f.charges = [];
    assert.strictEqual(ctx.catchUp(f), 0);
    assert.strictEqual(B.balance(f), 600);
});
