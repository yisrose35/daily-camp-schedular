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
vm.runInContext(cut('_postLedgerCharge') + '\nthis.post=_postLedgerCharge;', ctx);

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
    assert.match(ME, /\(f&&Array\.isArray\(f\.charges\)\?f\.charges:\[\]\)\.forEach\(function\(c\)\{ if\(_postLedgerCharge\(f,c\)\)_posted\+\+; \}\);/);
});

test('TED-062: Issue Credit and Add Charge refuse zero and negative amounts', () => {
    assert.match(ME, /var amt=Math\.round\(\(parseFloat\(document\.getElementById\('crAmount'\)\.value\)\|\|0\)\*100\)\/100;\s*\/\/[^\n]*\n[^\n]*\n\s*if\(!\(amt>0\)\)/);
    assert.match(ME, /var amt=Math\.round\(\(parseFloat\(document\.getElementById\('chgAmount'\)\.value\)\|\|0\)\*100\)\/100;\s*\/\/[^\n]*\n\s*if\(!\(amt>0\)\)/);
});
