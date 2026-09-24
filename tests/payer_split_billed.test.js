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
    const dialogs = [], htmls = [];
    const val = (id, v) => (els[id] = { value: v });
    const ctx = {
        families: { pine: fam }, payers: reg, _payersAPI: () => P, _billingCore: () => B, _secEdit: () => true,
        esc: (s) => String(s), fm: (n) => '$' + Number(n).toFixed(2), je: (s) => s, today: () => '2026-08-20',
        save() {}, closeModal() {}, renderBilling() {}, renderFamilyDetailPage() {}, curPage: 'billing',
        toast: (t) => toasts.push(t), showModal: (t, h, ok) => { onOk = ok; htmls.push(h); }, _payOptions: (ctx, sel) => { ctx_payOpts.push(sel); return ''; },
        confirmDialog: (o) => { dialogs.push(o); return Promise.resolve(true); }, _payLabel: (m) => m,
        _payerSharesFromForm: () => shares,
        document: { getElementById: (id) => els[id] || null, querySelectorAll: () => [] },
    };
    const names = ['addChargeForFamily', '_splitToPayers', '_familyOtherPayers', 'recordPayerPayment', '_postLedgerCharge',
        '_payerLedgerOf', '_migratePayerLedgers', '_payerLines', '_payerStanding', '_payerAccount', '_payerTotals', '_placePayerPayment', 'payerLines', 'voidPayerLine'];
    const fns = new Function(...Object.keys(ctx), names.map(cut).join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...Object.values(ctx));
    return { fam, reg, fns, els, toasts, dialogs, htmls, val, payOpts: ctx_payOpts, families: ctx.families, press: () => onOk && onOk() };
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

test('TED-190: an old page writing the old list back after the move does not count the fund\'s cheque twice', () => {
    const b = billing([]);
    b.reg.org_fund.ledger = [{ id: 'prc_c1_org_fund', kind: 'charge', amount: 800, familyKey: 'pine' }, { id: 'prp_old', kind: 'payment', amount: 1000 }];
    assert.strictEqual(b.fns._payerAccount('org_fund').paid, 1000);
    // the old page saves its copy of the registry, with the old list in it
    b.reg.org_fund.ledger = [{ id: 'prc_c1_org_fund', kind: 'charge', amount: 800, familyKey: 'pine' }, { id: 'prp_old', kind: 'payment', amount: 1000 }];
    const acc = b.fns._payerAccount('org_fund');
    assert.deepStrictEqual([acc.charged, acc.paid, acc.balance], [800, 1000, -200], 'the cheque (or the share) was counted twice');
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

test('TED-189: "Cancel share" — the fund no longer owes it, and neither does the family', async () => {
    const b = billing([{ payerId: 'org_fund', amount: 800 }]);
    split(b, 1000);
    const share = b.fam.payerLedger.find(e => e.kind === 'charge');
    b.fns.voidPayerLine('org_fund', share.id, 'cancel');
    await tick();
    assert.strictEqual(b.fns._payerAccount('org_fund').balance, 0);
    assert.strictEqual(B.balance(b.fam), 200, 'the cancelled share was billed to the household');
    assert.ok(!b.fam.charges.some(c => /^prback_/.test(c.id)));
    // and the credit window points the office to it
    assert.match(ME, /A credit here comes off <strong>/);
});

test('TED-198: a fund that paid $300 before its share was cancelled shows a credit, not "owes $-300", and keeps its Account button', async () => {
    const b = billing([{ payerId: 'org_fund', amount: 800 }]);
    split(b, 1000);
    b.fns.recordPayerPayment('org_fund');
    b.val('ppAmt', '300'); b.val('ppDate', '2026-08-25'); b.val('ppMethod', 'check'); b.val('ppRef', '#9');
    b.press();
    const share = b.fam.payerLedger.find(e => e.kind === 'charge');
    b.fns.voidPayerLine('org_fund', share.id, 'cancel');
    await tick();
    const last = b.toasts[b.toasts.length - 1];
    assert.match(last, /Credit \$300\.00 — return it to them, or keep it for a later share/);
    assert.doesNotMatch(last, /\$-/);
    // Manage payers: Account whenever the payer has any line, not only while it owes
    assert.match(ME, /\+\(_payerAccount\(id\)\.lines\.length\?'<button[^\n]*\n[^\n]*payerLines/);
});

test('TED-199 (M17): a cheque that was split across two families is not placed again by an old page', () => {
    const b = billing([]);
    const oak = { name: 'Oak', balance: 0, charges: [], credits: [], entries: [],
        payerLedger: [{ id: 'prc_o_org_fund', payerId: 'org_fund', kind: 'charge', amount: 400 }] };
    b.families.oak = oak;
    b.fam.payerLedger = [{ id: 'prc_p_org_fund', payerId: 'org_fund', kind: 'charge', amount: 600 }];
    // the cheque, moved earlier as two pieces (prp_old_0 / prp_old_1)
    b.fam.payerLedger.push({ id: 'prp_old_0', payerId: 'org_fund', kind: 'payment', paymentId: 'prp_old', amount: 600 });
    oak.payerLedger.push({ id: 'prp_old_1', payerId: 'org_fund', kind: 'payment', paymentId: 'prp_old', amount: 400 });
    // an old page writes the old list back
    b.reg.org_fund.ledger = [{ id: 'prp_old', kind: 'payment', amount: 1000 }];
    const acc = b.fns._payerAccount('org_fund');
    assert.deepStrictEqual([acc.charged, acc.paid, acc.balance], [1000, 1000, 0], 'the split cheque was placed again');
});

test('TED-204 (N13): the Cancel-share window says what the fund already paid', async () => {
    const b = billing([{ payerId: 'org_fund', amount: 800 }]);
    split(b, 1000);
    b.fns.recordPayerPayment('org_fund');
    b.val('ppAmt', '300'); b.val('ppDate', '2026-08-25'); b.val('ppMethod', 'check'); b.val('ppRef', '');
    b.press();
    const share = b.fam.payerLedger.find(e => e.kind === 'charge');
    b.fns.voidPayerLine('org_fund', share.id, 'cancel');
    await tick();
    assert.match(b.dialogs[b.dialogs.length - 1].message, /Scholarship Fund has paid \$300\.00 so far/);
});

test('TED-203: Move back after the fund paid $300 of its $800 share — only the unpaid $500 goes to the family, and the window says so', async () => {
    const b = billing([{ payerId: 'org_fund', amount: 800 }]);
    split(b, 1000);
    b.fns.recordPayerPayment('org_fund');
    b.val('ppAmt', '300'); b.val('ppDate', '2026-08-25'); b.val('ppMethod', 'check'); b.val('ppRef', '');
    b.press();
    const share = b.fam.payerLedger.find(e => e.kind === 'charge');
    b.fns.voidPayerLine('org_fund', share.id);
    await tick();
    const d = b.dialogs[b.dialogs.length - 1];
    assert.match(d.message, /already paid \$300\.00 toward it/);
    assert.match(d.message, /only the unpaid \$500\.00 moves to the Pine family/);
    assert.strictEqual(B.balance(b.fam), 700, 'the family was billed money the fund already paid');
    const acc = b.fns._payerAccount('org_fund');
    assert.deepStrictEqual([acc.charged, acc.paid, acc.balance], [300, 300, 0]);
    assert.match(b.toasts[b.toasts.length - 1], /\$500\.00 moved back to Pine.s bill — Scholarship Fund.s \$300\.00 stays on the share/);
    // pressed again: nothing more
    b.fns.voidPayerLine('org_fund', share.id);
    await tick();
    assert.strictEqual(B.balance(b.fam), 700);
    // a fund that paid nothing: the whole share moves, as before
    const c = billing([{ payerId: 'org_fund', amount: 800 }]);
    split(c, 1000);
    c.fns.voidPayerLine('org_fund', c.fam.payerLedger.find(e => e.kind === 'charge').id);
    await tick();
    assert.strictEqual(B.balance(c.fam), 1000);
    assert.match(c.dialogs[0].message, /Scholarship Fund will no longer owe it/);
});

test('TED-209: a share the fund has paid in full offers no Move back, and pressing it anyway writes nothing', async () => {
    const b = billing([{ payerId: 'org_fund', amount: 800 }]);
    split(b, 1000);
    b.fns.recordPayerPayment('org_fund');
    b.val('ppAmt', '300'); b.val('ppDate', '2026-08-25'); b.val('ppMethod', 'check'); b.val('ppRef', '');
    b.press();
    const share = b.fam.payerLedger.find(e => e.kind === 'charge');
    b.fns.voidPayerLine('org_fund', share.id);
    await tick();
    const kept = b.fam.payerLedger.find(e => /^prkeep_/.test(e.id));
    assert.ok(kept && kept.amount === 300);
    const before = b.fam.payerLedger.length;
    b.fns.voidPayerLine('org_fund', kept.id);
    await tick();
    assert.strictEqual(b.fam.payerLedger.length, before, 'lines were added for a share with nothing to move');
    assert.match(b.toasts[b.toasts.length - 1], /Nothing to move back — Scholarship Fund has paid this share in full/);
    assert.strictEqual(B.balance(b.fam), 700);
    // the account window shows "paid" for it, not a Move back button
    b.fns.payerLines('org_fund');
    const html = b.htmls[b.htmls.length - 1];
    const row = html.split('<tr>').find(r => r.includes(kept.id));
    assert.ok(row, html);
    assert.match(row, />paid<\/span>/);
    assert.doesNotMatch(row, /Move back to family/);
    // the description never doubles
    b.fns.recordPayerPayment('org_fund');
    const pay = b.fam.payerLedger.find(e => e.kind === 'payment');
    b.fns.voidPayerLine('org_fund', pay.paymentId);       // the cheque removed: the kept part is owed again
    await tick();
    // a new $100 cheque: moving the kept line back keeps $100 of it (TED-214 Q23)
    b.fns.recordPayerPayment('org_fund');
    b.val('ppAmt', '100'); b.val('ppDate', '2026-08-26'); b.val('ppMethod', 'check'); b.val('ppRef', '');
    b.press();
    b.fns.voidPayerLine('org_fund', kept.id);
    await tick();
    const again = b.fam.payerLedger.find(e => e.id === 'prkeep_' + kept.id);
    assert.ok(again && again.amount === 100, JSON.stringify(b.fam.payerLedger.map(e => [e.id, e.amount])));
    assert.ok(!b.fam.payerLedger.some(e => /the part Scholarship Fund paid — the part/.test(e.description || '')),
        'the title doubled: ' + again.description);
});
