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

// The save button of a modal, found by a marker inside its showModal() call.
function callbackAt(marker) {
    const at = ME.indexOf(marker);
    assert.ok(at >= 0, marker + ' is missing');
    const fnAt = ME.indexOf('function(', at);
    let i = ME.indexOf('{', fnAt), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(fnAt, i + 1);
}
function runCallback(marker, extra) {
    const f = family();
    const c = Object.assign({ _billingCore: () => B, B, families: { fg: f }, curPage: 'billing',
        toast() {}, save() {}, closeModal() {}, renderBilling() {}, renderFamilyDetailPage() {},
        fm: (n) => '$' + n, today: () => '2026-07-10', _camperIdOf: () => null }, extra(f));
    vm.createContext(c);
    vm.runInContext(cut('_postLedgerCharge') + '\n' + cut('_postLedgerCredit') +
        '\nthis.cb=' + callbackAt(marker) + ';', c);
    c.cb();
    return f;
}

test('TED-053/076: Charge several accounts posts each charge to the ledger', () => {
    const f = runCallback("showModal(kind==='charge'?'Charge several accounts'", () => ({ kind: 'charge',
        _baPlan: () => ({ ok: true, count: 1, total: 30, entries: [{ key: 'fg', amount: 30, reason: 'Trip' }] }) }));
    assert.strictEqual(B.balance(f), 630);
});

test('TED-053/076: a card surcharge reaches the ledger', () => {
    const f = runCallback("showModal('Add card surcharge'", (fam) => ({ f: fam, pol: {},
        document: { getElementById: () => ({ value: '100' }) },
        F: { quote: () => ({ permitted: true, fee: 3, mode: 'surcharge', reason: '' }), disclosure: () => '3% card fee' } }));
    assert.strictEqual(B.balance(f), 603);
});

test('TED-053/076: Charge late fees posts each fee to the ledger, once', () => {
    const f = runCallback("showModal('Charge late fees'", () => ({ asOf: '2026-07-10', applied: {}, billingRules: {},
        toCharge: [{ famKey: 'fg', plan: { toApply: [{ key: 'lf_a', amount: 25, note: 'Late' }, { key: 'lf_a', amount: 25 }] } }],
        B: Object.assign({}, B, { recordLateFees: (x) => x }) }));
    assert.strictEqual(B.balance(f), 625);
});

test('close-out and Add Charge post through _postLedgerCharge; Billing posts old ones on load', () => {
    // close-out's writer runs inside a larger forEach, not a callback of its own
    assert.match(ME, /category:'Close-out'[\s\S]{0,300}?_postLedgerCharge\(f,f\.charges\[f\.charges\.length-1\]\)/);
    assert.match(ME, /_posted\+=_postExistingCharges\(f\);/);
});

// The real Add Charge / Issue Credit save buttons (the callbacks handed to
// showModal), run against a stub form — TED-076: behaviour, not source text.
function modalCallback(title) {
    const at = ME.indexOf("showModal('" + title + "',h,");
    assert.ok(at >= 0, title + ' modal is missing');
    const fnAt = ME.indexOf('function(', at);
    const start = ME.lastIndexOf(ME.slice(fnAt - 6, fnAt) === 'async ' ? 'async ' : 'function(', fnAt);
    let i = ME.indexOf('{', fnAt), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(start, i + 1);
}
function runForm(title, fields) {
    const f = family();
    const toasts = [];
    const c = { _billingCore: () => B, families: { fg: f }, curPage: 'billing', finPayments: [],
        document: { getElementById: (id) => ({ value: fields[id] != null ? fields[id] : '' }) },
        toast: (m, k) => toasts.push([m, k]), save() {}, closeModal() {}, renderBilling() {},
        renderFamilyDetailPage() {}, fm: (n) => '$' + n, _payersAPI: () => null,
        _payerSharesFromForm: () => [], _camperIdOf: () => null };
    vm.createContext(c);
    vm.runInContext(cut('_postLedgerCharge') + '\n' + cut('_postLedgerCredit') +
        '\nthis.cb=' + modalCallback(title) + ';', c);
    return Promise.resolve(c.cb()).then(() => ({ f, toasts }));
}

test('TED-062: Add Charge refuses zero and negative amounts, and posts a real one', async () => {
    for (const v of ['0', '-50', '', 'abc']) {
        const { f, toasts } = await runForm('Add Charge', { chgFamKey: 'fg', chgAmount: v, chgCategory: 'Trip' });
        assert.strictEqual(B.balance(f), 600, 'Add Charge of "' + v + '" changed the balance');
        assert.ok(!f.charges || !f.charges.length, 'Add Charge of "' + v + '" was recorded');
        assert.strictEqual(toasts[0][1], 'error');
    }
    const { f } = await runForm('Add Charge', { chgFamKey: 'fg', chgAmount: '50', chgCategory: 'Trip', chgDesc: 'Zoo' });
    assert.strictEqual(B.balance(f), 650, 'a $50 Add Charge must reach the ledger');
    assert.strictEqual(f.charges.length, 1);
});

test('TED-062: Issue Credit refuses zero and negative amounts, and posts a real one', async () => {
    for (const v of ['0', '-50', '']) {
        const { f, toasts } = await runForm('Issue Credit/Refund', { crFamKey: 'fg', crType: 'credit', crAmount: v, crReason: 'x' });
        assert.strictEqual(B.balance(f), 600, 'Issue Credit of "' + v + '" changed the balance');
        assert.ok(!f.credits || !f.credits.length, 'Issue Credit of "' + v + '" was recorded');
        assert.strictEqual(toasts[0][1], 'error');
    }
    const { f } = await runForm('Issue Credit/Refund', { crFamKey: 'fg', crType: 'credit', crAmount: '75', crReason: 'Sibling' });
    assert.strictEqual(B.balance(f), 525, 'a $75 credit must reach the ledger');
    assert.strictEqual(f.credits.length, 1);
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

test('TED-066: a charge that disappears comes off the ledger, once', () => {
    const f = family();
    f.charges = [{ id: 'chg_o1', category: 'Trip', amount: 40 }];
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

test('TED-081: merging two families keeps every charge the second one was billed', () => {
    const mctx = { _billingCore: () => B, families: {}, curPage: 'billing',
        _meAudit() {}, save() {}, render() {}, toast() {} };
    vm.createContext(mctx);
    vm.runInContext(cut('_postLedgerCharge') + '\n' + cut('_postExistingCharges') + '\n' +
        cut('mergeFamiliesReconciled') + '\nthis.merge=mergeFamiliesReconciled;this.catchUp=_postExistingCharges;', mctx);
    const a = family();                                   // owes $600
    const b = family();                                   // owes $600 ...
    b.name = 'Gold (dup)';
    b.charges = [{ id: 'lf_b', category: 'Late Fee', amount: 25, date: '2026-07-01' }];
    b.credits = [{ id: 'cr_b', reason: 'Sibling', amount: 10, date: '2026-07-02' }];
    mctx.catchUp(b);                                      // ... + the $25 fee = $625
    b.entries.forEach((e, i) => { if (!e.id.startsWith('le_chg_')) e.id = e.id + '_b' + i; });
    assert.strictEqual(B.balance(b), 625);
    mctx.families.fa = a; mctx.families.fb = b;
    mctx.merge('fa', 'fb', null);
    const m = mctx.families.fa;
    assert.ok(!mctx.families.fb);
    assert.strictEqual(B.balance(m), 1225);
    assert.strictEqual(mctx.catchUp(m), 0, 'the catch-up posted something after a merge');
    assert.strictEqual(B.balance(m), 1225, 'the merged family was let off B\'s fee');
    assert.deepStrictEqual(Array.from(m.charges, c => c.id), ['lf_b']);
    assert.deepStrictEqual(Array.from(m.credits, c => c.id), ['cr_b']);
});

test('TED-082: a charge the conversion posted is linked, so re-pricing and cancelling it follow', () => {
    const f = { name: 'Conv', entries: [
        { id: 'le_conv_g_1', kind: 'charge', amount: 1000, reason: 'tuition', source: { enrollmentId: 'e1' } },
        { id: 'le_conv_g_2', kind: 'charge', amount: 40, reason: 'fee', date: '2026-07-01', source: {} },
        { id: 'le_conv_g_3', kind: 'payment', amount: 1000, reason: 'card' }],
      charges: [{ id: 'chg_o1', category: 'Trip', amount: 40, date: '2026-07-01' }] };
    assert.strictEqual(ctx.catchUp(f), 0);
    assert.strictEqual(f.entries[1].source.chargeId, 'chg_o1', 'the converted entry was not linked');
    assert.strictEqual(B.balance(f), 40);
    f.charges[0].amount = 55;                             // re-priced
    ctx.catchUp(f); ctx.catchUp(f);
    assert.strictEqual(B.balance(f), 55, 'a re-priced converted charge was counted twice');
    f.charges = [];                                       // cancelled
    ctx.catchUp(f); ctx.catchUp(f);
    assert.strictEqual(B.balance(f), 0, 'a cancelled converted charge is still billed');
});

test('TED-082: a converted fee migration 267 already linked is not handed to another charge', () => {
    const f = { name: 'Linked', entries: [
        { id: 'le_conv_l_1', kind: 'charge', amount: 25, reason: 'fee', date: '2026-07-01', source: { chargeId: 'lf_a' } }],
      charges: [{ id: 'lf_a', amount: 25, date: '2026-07-01' }, { id: 'lf_b', amount: 25, date: '2026-07-01' }] };
    assert.strictEqual(ctx.catchUp(f), 1, 'the second $25 fee must be posted — the converted one is lf_a\'s');
    assert.strictEqual(B.balance(f), 50);
});

test('TED-091: a shop charge a stale tab never saw is NOT taken off by its Billing load', () => {
    const f = family();
    // what settle_shop_order posted after this tab loaded (the tab's charges[] lacks it)
    f.entries.push({ id: 'le_chg_shop_o9', kind: 'charge', amount: 40, reason: 'fee', source: { chargeId: 'shop_o9' } });
    f.charges = [{ id: 'chg_10', category: 'Other', amount: 10 }];
    ctx.catchUp(f); ctx.catchUp(f);
    assert.strictEqual(B.balance(f), 650, 'the shop order was cancelled by an old tab');
});

test('TED-108: both Record Payment forms refuse zero and negative amounts', async () => {
    for (const [field, extra] of [['payAmount', { payFamKey: 'fg', payMethod: 'check', payDate: '2026-07-01', payRef: '', payNotes: '' }],
                                  ['fapAmount', { fapFamily: 'Gold', fapMethod: 'check', fapDate: '2026-07-01' }]]) {
        for (const v of ['-500', '0', '']) {
            const f = family(); const toasts = []; const pushed = [];
            const c = { _billingCore: () => B, families: { fg: f }, curPage: 'billing', finPayments: pushed,
                document: { getElementById: (id) => ({ value: id === field ? v : (extra[id] != null ? extra[id] : '') }) },
                toast: (m, k) => toasts.push([m, k]), save() {}, closeModal() {}, renderBilling() {}, renderFinance() {},
                renderFamilyDetailPage() {}, fm: (n) => '$' + n, _payAllowed: () => true, today: '2026-07-01' };
            vm.createContext(c);
            vm.runInContext('this.cbs=[' + [...ME.matchAll(/showModal\('Record Payment',h,/g)].map(m => {
                const fnAt = ME.indexOf('function(', m.index);
                let i = ME.indexOf('{', fnAt), d = 0;
                for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
                return ME.slice(fnAt, i + 1);
            }).join(',') + '];', c);
            const cb = c.cbs.find(fn => fn.toString().includes(field));
            await cb();
            assert.strictEqual(pushed.length, 0, field + ' "' + v + '" was recorded as a payment');
            assert.strictEqual(B.balance(f), 600);
            assert.strictEqual(toasts[0][1], 'error');
        }
    }
});
