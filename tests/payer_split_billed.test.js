// =============================================================================
// payer_split_billed.test.js — TED-165, Billing's own Add Charge.
//
// "Split between payers" was saved and never used: Pine's $1,000 charge with
// $800 from the Scholarship Fund put $1,000 on Pine's bill, in Link and in
// tonight's autopay. Now the household's bill carries the household's share
// only; the fund's share is on the fund's own account (Manage payers), where
// its cheque is recorded — never on the family's.
//
// TED-177: those lines now live on the household's family record
// (payerLedger), which is saved as its own row and merged by id on the server
// (migration 286, pgtest 286) — an office computer left open from before can
// no longer wipe them, as it could when they sat on the payer in the settings
// document. TED-178: they count in Finance, and a mistaken line can be taken
// back. TED-179: the Manage payers row is well-formed.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
const B = require('../campistry_billing_core.js');
const P = require('../campistry_payers.js');
function cut(name) {
    const at = ME.search(new RegExp('(async )?function ' + name + '\\('));
    assert.ok(at >= 0, name + ' is missing');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    return ME.slice(at, i + 1);
}

function billing(shares) {
    const fam = { name: 'Pine', balance: 0, charges: [], credits: [], entries: [] };
    B.post(fam, { id: 'le_chg_old', kind: 'charge', amount: 100, reason: 'tuition' });
    B.post(fam, { id: 'le_pay_old', kind: 'payment', amount: 100, reason: 'check' });
    const reg = P.normalize({ org_fund: { name: 'Scholarship Fund', kind: 'organization' } });
    const els = {}, toasts = [], ctx_payOpts = [];
    let onOk = null;
    const val = (id, v) => (els[id] = { value: v });
    const ctx = {
        families: { pine: fam }, payers: reg, _payersAPI: () => P, _billingCore: () => B, _secEdit: () => true,
        esc: (s) => String(s), fm: (n) => '$' + Number(n).toFixed(2), je: (s) => s, today: () => '2026-08-20',
        save() {}, closeModal() {}, renderBilling() {}, renderFamilyDetailPage() {}, curPage: 'billing',
        toast: (t) => toasts.push(t), showModal: (t, h, ok) => { onOk = ok; }, _payOptions: (ctx, sel) => { ctx_payOpts.push(sel); return ''; },
        confirmDialog: () => Promise.resolve(true), _payLabel: (m) => m,
        _payerSharesFromForm: () => shares,
        document: { getElementById: (id) => els[id] || null, querySelectorAll: () => [] },
    };
    const names = ['addChargeForFamily', '_splitToPayers', '_familyOtherPayers', 'recordPayerPayment', '_postLedgerCharge',
        '_payerLedgerOf', '_migratePayerLedgers', '_payerLines', '_payerAccount', '_payerTotals', '_placePayerPayment', 'payerLines', 'voidPayerLine'];
    const fns = new Function(...Object.keys(ctx), names.map(cut).join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...Object.values(ctx));
    return { fam, reg, fns, els, toasts, val, payOpts: ctx_payOpts, families: ctx.families, press: () => onOk && onOk() };
}

test('TED-165: $1,000 with $800 from the Scholarship Fund — Pine is billed $200; the fund owes $800 on its own account', () => {
    const b = billing([{ payerId: 'org_fund', amount: 800 }]);
    b.fns.addChargeForFamily('pine');
    b.val('chgFamKey', 'pine'); b.val('chgCategory', 'Tuition'); b.val('chgDesc', 'Summer tuition'); b.val('chgAmount', '1000'); b.val('chgDate', '2026-08-20');
    b.press();
    assert.strictEqual(B.balance(b.fam), 200, 'the household was billed the fund\'s share too');
    assert.strictEqual(b.fam.charges[0].amount, 200);
    assert.strictEqual(b.fam.charges[0].fullAmount, 1000);
    const acc = b.fns._payerAccount('org_fund');
    assert.deepStrictEqual([acc.charged, acc.paid, acc.balance], [800, 0, 800]);
    // TED-177: on the household's own record, not on the payer in the settings document
    assert.strictEqual(b.fam.payerLedger.length, 1);
    assert.strictEqual(b.fam.payerLedger[0].payerId, 'org_fund');
    assert.ok(!(b.reg.org_fund.ledger || []).length, 'the share is still kept on the payer');
    assert.match(b.toasts[0], /Pine owes \$200\.00; Scholarship Fund owes \$800\.00/);
    // the family page says who else is paying
    assert.deepStrictEqual(JSON.parse(JSON.stringify(b.fns._familyOtherPayers('pine'))),
        [{ payerId: 'org_fund', name: 'Scholarship Fund', share: 800, owes: 800 }]);
});

test('TED-165: the fund\'s cheque is recorded on the fund — the family\'s balance does not move', () => {
    const b = billing([{ payerId: 'org_fund', amount: 800 }]);
    b.fns.addChargeForFamily('pine');
    b.val('chgFamKey', 'pine'); b.val('chgCategory', 'Tuition'); b.val('chgDesc', 'x'); b.val('chgAmount', '1000'); b.val('chgDate', '2026-08-20');
    b.press();
    b.fns.recordPayerPayment('org_fund');
    b.val('ppAmt', '800'); b.val('ppDate', '2026-08-25'); b.val('ppMethod', 'check'); b.val('ppRef', '#77');
    b.press();
    assert.strictEqual(b.fns._payerAccount('org_fund').balance, 0);
    assert.strictEqual(B.balance(b.fam), 200, 'the fund\'s cheque landed on the family');
    assert.deepStrictEqual(b.payOpts, ['check'], 'TED-178: a fund\'s payment should start on Check');
    assert.strictEqual(b.fam.payerLedger.filter(e => e.kind === 'payment').length, 1);
});

test('TED-165: a percentage split, and no split at all', () => {
    const b = billing([{ payerId: 'org_fund', pct: 25 }]);
    b.fns.addChargeForFamily('pine');
    b.val('chgFamKey', 'pine'); b.val('chgCategory', 'Tuition'); b.val('chgDesc', 'x'); b.val('chgAmount', '1000'); b.val('chgDate', '2026-08-20');
    b.press();
    assert.strictEqual(B.balance(b.fam), 750);
    const plain = billing([]);
    plain.fns.addChargeForFamily('pine');
    plain.val('chgFamKey', 'pine'); plain.val('chgCategory', 'Trip Fee'); plain.val('chgDesc', 'x'); plain.val('chgAmount', '60'); plain.val('chgDate', '2026-08-20');
    plain.press();
    assert.strictEqual(B.balance(plain.fam), 60);
    assert.ok(!('fullAmount' in plain.fam.charges[0]), 'an ordinary charge changed shape');
});

function split(b, amt) {
    b.fns.addChargeForFamily('pine');
    b.val('chgFamKey', 'pine'); b.val('chgCategory', 'Tuition'); b.val('chgDesc', 'Summer'); b.val('chgAmount', String(amt)); b.val('chgDate', '2026-08-20');
    b.press();
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('TED-177: accounts kept on the payer before the move are moved onto the families once', () => {
    const b = billing([]);
    b.reg.org_fund.ledger = [{ id: 'prc_c1_org_fund', kind: 'charge', amount: 800, familyKey: 'pine' }, { id: 'prp_old', kind: 'payment', amount: 300 }];
    const acc = b.fns._payerAccount('org_fund');
    assert.deepStrictEqual([acc.charged, acc.paid, acc.balance], [800, 300, 500]);
    assert.ok(!('ledger' in b.reg.org_fund));
    assert.strictEqual(b.fam.payerLedger.length, 2);
    assert.strictEqual(b.fns._payerAccount('org_fund').balance, 500, 'moved twice');
});

test('TED-178: Finance counts the fund — charged, collected, outstanding and its cheque in the log', () => {
    const b = billing([{ payerId: 'org_fund', amount: 800 }]);
    split(b, 1000);
    b.fns.recordPayerPayment('org_fund');
    b.val('ppAmt', '300'); b.val('ppDate', '2026-08-25'); b.val('ppMethod', 'check'); b.val('ppRef', '#77');
    b.press();
    const t = b.fns._payerTotals();
    assert.deepStrictEqual([t.charged, t.paid, t.outstanding], [800, 300, 500]);
    assert.deepStrictEqual(t.payments.map(p => [p.name, p.amount, p.method, p.reference]), [['Scholarship Fund', 300, 'check', '#77']]);
    // and the two Finance screens add them in
    assert.match(ME, /var _finPayers=_payerTotals\(\);\s*totalCollected\+=_finPayers\.paid; totalOutstanding\+=_finPayers\.outstanding;/);
    assert.match(ME, /_charged\+=_anPay\.charged; _collected\+=_anPay\.paid; _outstanding\+=_anPay\.outstanding;/);
});

test('TED-178: a cheque entered by mistake is removed; a share billed by mistake goes back to the family', async () => {
    const b = billing([{ payerId: 'org_fund', amount: 800 }]);
    split(b, 1000);
    b.fns.recordPayerPayment('org_fund');
    b.val('ppAmt', '300'); b.val('ppDate', '2026-08-25'); b.val('ppMethod', 'check'); b.val('ppRef', '');
    b.press();
    const pay = b.fam.payerLedger.find(e => e.kind === 'payment');
    b.fns.voidPayerLine('org_fund', pay.paymentId);
    await tick();
    assert.strictEqual(b.fns._payerAccount('org_fund').balance, 800, 'the removed cheque still counts');
    b.fns.voidPayerLine('org_fund', pay.paymentId);            // again: nothing more
    await tick();
    assert.strictEqual(b.fns._payerAccount('org_fund').balance, 800);
    const share = b.fam.payerLedger.find(e => e.kind === 'charge');
    b.fns.voidPayerLine('org_fund', share.id);
    await tick();
    assert.strictEqual(b.fns._payerAccount('org_fund').balance, 0);
    assert.strictEqual(B.balance(b.fam), 1000, 'the share did not come back to the household');
    assert.deepStrictEqual(b.fns._familyOtherPayers('pine'), []);
    // the list only grows: a correction is a new line
    assert.strictEqual(b.fam.payerLedger.filter(e => e.kind === 'void').length, 2);
});

test('TED-178: one cheque for two families pays each family\'s share', () => {
    const b = billing([{ payerId: 'org_fund', amount: 500 }]);
    split(b, 1000);
    const oak = { name: 'Oak', balance: 0, charges: [], credits: [], entries: [] };
    b.families.oak = oak;
    oak.payerLedger = [{ id: 'prc_x_org_fund', payerId: 'org_fund', kind: 'charge', amount: 400, date: '2026-08-21' }];
    b.fns.recordPayerPayment('org_fund');
    b.val('ppAmt', '900'); b.val('ppDate', '2026-08-25'); b.val('ppMethod', 'check'); b.val('ppRef', '');
    b.press();
    const paid = (f) => f.payerLedger.filter(e => e.kind === 'payment').reduce((s, e) => s + e.amount, 0);
    assert.deepStrictEqual([paid(b.fam), paid(oak)], [500, 400]);
    assert.strictEqual(b.fns._payerTotals().payments.length, 1, 'one cheque shows as one payment');
});

test('TED-179: the Manage payers row closes its tags in the right place', () => {
    const at = ME.indexOf("+(p.contact||p.email||p.phone?'<div style=\"font-size:.74rem;color:var(--s400)\">'");
    const row = ME.slice(ME.lastIndexOf("h+='<div style=\"display:flex;gap:8px;align-items:center", at), ME.indexOf("+'</div>';\n        });", at));
    const opens = (row.match(/<div/g) || []).length, closes = (row.match(/<\/div>/g) || []).length;
    // the row itself is closed by the line after the slice
    assert.strictEqual(closes, opens - 1, 'unbalanced: ' + opens + ' opened, ' + closes + ' closed before the row ends');
});

test('TED-165: the payer accounts survive a save (the registry keeps them)', () => {
    const reg = P.normalize({ org_fund: { name: 'F', kind: 'organization', ledger: [
        { id: 'prc_1', kind: 'charge', amount: 800 }, { id: 'prp_1', kind: 'payment', amount: 300 }, { junk: 1 }] } });
    assert.strictEqual(reg.org_fund.ledger.length, 2);
    assert.strictEqual(P.account(reg.org_fund).balance, 500);
});
