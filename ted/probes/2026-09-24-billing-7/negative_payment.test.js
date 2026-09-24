// Probe (7th pass, new): Billing → Record Payment with a minus sign typed in
// the amount (-500). TED-062 made Add Credit refuse ≤ 0; does Record Payment?
// The real openPaymentForFamily + _postPaymentEntry from campistry_me.js, with
// the modal's Save pressed and the fields filled as the office would.
// Run: node --test ted/probes/2026-09-24-billing-7/negative_payment.test.js
'use strict';
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const ROOT = '/home/user/daily-camp-schedular';
const ME = fs.readFileSync(ROOT + '/campistry_me.js', 'utf8');
const B = require(ROOT + '/campistry_billing_core.js');
function cut(name) {
  const at = ME.indexOf('function ' + name + '(');
  let i = ME.indexOf('{', at), d = 0;
  for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
  return ME.slice(at, i + 1);
}
test('probe', () => {
  const fields = { payFamKey: 'gold', payAmount: '-500', payDate: '2026-07-01', payMethod: 'Check', payRef: '', payNotes: '' };
  let onSave = null; const toasts = [];
  const ctx = {
    _billingCore: () => B, finPayments: [], roster: {}, families: {}, curPage: 'billing',
    esc: s => String(s), fm: n => '$' + Number(n).toFixed(2), save() {}, renderBilling() {}, renderFamilyDetailPage() {}, closeModal() {},
    _secEdit: () => true, toast: (m) => toasts.push(m), _payOptions: () => '', _payBlockedNote: () => '', _payAllowed: () => true,
    buildFamilyLedgers: () => ({}), showModal: (t, h, cb) => { onSave = cb; },
    document: { getElementById: (id) => ({ value: fields[id] }) }, Date,
  };
  vm.createContext(ctx);
  vm.runInContext(['_camperIdOf', '_paymentRefOf', '_paymentRefsOf', '_postPaymentEntry', 'openPaymentForFamily'].map(cut).join('\n') + '\nthis.open=openPaymentForFamily;', ctx);
  const f = { name: 'Gold', entries: [] };
  ctx.families.gold = f;
  B.post(f, { id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', note: 'Tuition' });
  const before = B.balance(f);
  ctx.open('gold');
  onSave();
  const e = (f.entries || []).filter(x => x.kind !== 'charge');
  console.log(`# typed -500 into Record Payment → toast "${toasts.join(' / ')}" | payment rows ${JSON.stringify(ctx.finPayments.map(p => p.amount))} | ledger entries ${JSON.stringify(e.map(x => ({ kind: x.kind, amount: x.amount, reason: x.reason })))} | balance ${before} → ${B.balance(f)}`);
});
