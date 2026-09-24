// =============================================================================
// payer_split_billed.test.js — TED-165, Billing's own Add Charge.
//
// "Split between payers" was saved and never used: Pine's $1,000 charge with
// $800 from the Scholarship Fund put $1,000 on Pine's bill, in Link and in
// tonight's autopay. Now the household's bill carries the household's share
// only; the fund's share is on the fund's own account (Manage payers), where
// its cheque is recorded — never on the family's.
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
    const els = {}, toasts = [];
    let onOk = null;
    const val = (id, v) => (els[id] = { value: v });
    const ctx = {
        families: { pine: fam }, payers: reg, _payersAPI: () => P, _billingCore: () => B, _secEdit: () => true,
        esc: (s) => String(s), fm: (n) => '$' + Number(n).toFixed(2), je: (s) => s, today: () => '2026-08-20',
        save() {}, closeModal() {}, renderBilling() {}, renderFamilyDetailPage() {}, curPage: 'billing',
        toast: (t) => toasts.push(t), showModal: (t, h, ok) => { onOk = ok; }, _payOptions: () => '',
        _payerSharesFromForm: () => shares,
        document: { getElementById: (id) => els[id] || null, querySelectorAll: () => [] },
    };
    const names = ['addChargeForFamily', '_splitToPayers', '_familyOtherPayers', 'recordPayerPayment', '_postLedgerCharge'];
    const fns = new Function(...Object.keys(ctx), names.map(cut).join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...Object.values(ctx));
    return { fam, reg, fns, els, toasts, val, press: () => onOk && onOk() };
}

test('TED-165: $1,000 with $800 from the Scholarship Fund — Pine is billed $200; the fund owes $800 on its own account', () => {
    const b = billing([{ payerId: 'org_fund', amount: 800 }]);
    b.fns.addChargeForFamily('pine');
    b.val('chgFamKey', 'pine'); b.val('chgCategory', 'Tuition'); b.val('chgDesc', 'Summer tuition'); b.val('chgAmount', '1000'); b.val('chgDate', '2026-08-20');
    b.press();
    assert.strictEqual(B.balance(b.fam), 200, 'the household was billed the fund\'s share too');
    assert.strictEqual(b.fam.charges[0].amount, 200);
    assert.strictEqual(b.fam.charges[0].fullAmount, 1000);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(P.account(b.reg.org_fund))), { charged: 800, paid: 0, balance: 800 });
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
    assert.strictEqual(P.account(b.reg.org_fund).balance, 0);
    assert.strictEqual(B.balance(b.fam), 200, 'the fund\'s cheque landed on the family');
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

test('TED-165: the payer accounts survive a save (the registry keeps them)', () => {
    const reg = P.normalize({ org_fund: { name: 'F', kind: 'organization', ledger: [
        { id: 'prc_1', kind: 'charge', amount: 800 }, { id: 'prp_1', kind: 'payment', amount: 300 }, { junk: 1 }] } });
    assert.strictEqual(reg.org_fund.ledger.length, 2);
    assert.strictEqual(P.account(reg.org_fund).balance, 500);
});
