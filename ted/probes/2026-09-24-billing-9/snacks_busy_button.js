// Probe (9th pass, TED-109 page half). The REAL refundAmtChanged /
// refundCanteenDeposit / _edgeFnErrorMessage cut from campistry_snacks.js, run
// with a tiny fake page. While a refund is on its way:
//   1. retyping the amount must not turn the Refund button back on;
//   2. pressing Refund again (double-click, or the button re-enabled some
//      other way) must not send a second request.
// Then, after the answer: the button comes back, and a retry after an ERROR
// reuses the same key (so it meets the first attempt), while a retry after
// success uses a new key.
// Run: node ted/probes/2026-09-24-billing-9/snacks_busy_button.js
const fs = require('fs');
const src = fs.readFileSync('/home/user/daily-camp-schedular/campistry_snacks.js', 'utf8');
const cut = (re) => { const m = src.match(re); if (!m) throw new Error('not found: ' + re); return m[0]; };
const amtChanged = cut(/window\.refundAmtChanged = function\(\) \{[\s\S]*?\n\};\n/);
const errMsg = cut(/async function _edgeFnErrorMessage\(res\) \{[\s\S]*?\n\}\n/);
const refund = cut(/window\.refundCanteenDeposit = async function\(\) \{[\s\S]*?\n\};\n/);

const els = {
  refundCamper: { value: 'Avi' },
  refundAmt: { value: '20.00', max: '100' },
  refundWarn: { style: {}, textContent: '' },
  refundBtn: { disabled: false, textContent: 'Refund' },
};
const sent = [];
let pending = [];
const window = {};
const document = { getElementById: (id) => els[id] || null };
const ctx = {
  window, document,
  _secEdit: () => true,
  toast: (m) => sent.push('toast: ' + m),
  closeM: () => {},
  _refreshSnacksFromCloud: () => {},
  getRoster: () => ({ Avi: { camperId: 7 } }),
  _getSnacksProcessorKey: async () => 'stripe',
};
window.confirm = () => false;
window.CampistryDB = { client: { functions: { invoke: (name, o) => {
  sent.push(name + ' key=' + o.body.idempotencyKey + ' amount=' + o.body.amount);
  return new Promise((res) => pending.push(res));
} } } };
const run = new Function(...Object.keys(ctx), amtChanged + errMsg + refund + '; return { amt: window.refundAmtChanged, refund: window.refundCanteenDeposit };');
const f = run(...Object.values(ctx));
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  f.refund(); f.refund();                    // a double-click
  await tick();
  console.log('after a double-click: requests sent =', sent.filter(s => s.startsWith('stripe')).length, '| button disabled =', els.refundBtn.disabled, '| label =', els.refundBtn.textContent);
  els.refundAmt.value = '20'; f.amt();        // the office retypes the amount
  console.log('after retyping the amount mid-refund: button disabled =', els.refundBtn.disabled);
  els.refundBtn.disabled = false; f.refund(); // even if the button were somehow pressed
  await tick();
  console.log('a third press mid-refund: requests sent =', sent.filter(s => s.startsWith('stripe')).length);
  // the answer comes back as an error (e.g. the browser's own network error)
  pending.shift()({ data: null, error: { message: 'Failed to send a request to the Edge Function' } });
  await tick();
  console.log('after an error answer: button disabled =', els.refundBtn.disabled, '| label =', els.refundBtn.textContent, '| warning =', JSON.stringify(els.refundWarn.textContent));
  f.refund(); await tick();
  pending.shift()({ data: { totalRefunded: 20, refunds: [{}] }, error: null });
  await tick();
  els.refundAmt.value = '20.00';
  f.refund(); await tick();
  pending.shift()({ data: { totalRefunded: 20, refunds: [{}] }, error: null });
  await tick();
  console.log('requests in order:\n  ' + sent.filter(s => s.startsWith('stripe')).join('\n  '));
  console.log('Expected: 1 request for the double-click and the third press; retry after the error has the SAME key; the next refund after success a NEW key.');
})();
