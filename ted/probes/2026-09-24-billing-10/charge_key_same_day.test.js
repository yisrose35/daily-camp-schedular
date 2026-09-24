// Probe (10th pass, TED-111 re-check): Me → Billing → Charge Card, the REAL page
// code (chargeStoredCard + its key store, cut from campistry_me.js the same way
// tests/office_charge_retry.test.js does) sending to the REAL stripe-charge /
// payments-charge functions (tests/edge_harness.js), with a pretend Stripe that
// answers a repeated Idempotency-Key with its first answer (Stripe's documented
// behaviour for 24 hours).
//
//   1. 10:00 — the office charges Gold $500. Stripe takes it; the answer is lost.
//      The page says "may have gone through" and keeps its key (23 hours).
//      (Stripe's webhook books pi_1 on the family, so Billing shows it paid.)
//   2. 15:00 — a new $500 fee is added for Gold; the office presses Charge Card
//      for $500. What does the page say, what does Stripe do, what is recorded?
//   Same for a Cardknox camp (payments-charge).
// Run: node --test ted/probes/2026-09-24-billing-10/charge_key_same_day.test.js
'use strict';
const test = require('node:test');
const fs = require('node:fs');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');
const ME = fs.readFileSync('/home/user/daily-camp-schedular/campistry_me.js', 'utf8');
const cut = (re) => { const m = ME.match(re); if (!m) throw new Error('not found ' + re); return m[0]; };
const SRC = [
  cut(/async function chargeStoredCard\(famKey,amount,description,quiet\)\{[\s\S]*?\n\}\n/),
  cut(/function _pendingChargeStoreKey\(\)\{[^\n]*\n/), cut(/function _pendingChargeAll\(\)\{[^\n]*\n/),
  cut(/function _pendingChargeGet\(famKey,amount\)\{[\s\S]*?\n\}\n/), cut(/function _pendingChargeSet\(famKey,amount,v\)\{[\s\S]*?\n\}\n/),
  cut(/function _pendingChargeClear\(famKey,amount\)\{[\s\S]*?\n\}\n/)].join('\n');

// Stripe / Cardknox memory shared across presses (each press is its own harness run)
const stripe = { keys: {}, charges: [] };
const ck = { claims: {}, sales: [] };
function callStripeCharge(body, loseAnswer) {
  const r = runEdge('stripe-charge', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', name: 'Camp One' }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', stripeCustomerId: 'cus_G' } });
const S = ${JSON.stringify(stripe)}; T.tables.__stripe = S;
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_methods/')) return { id: 'pm_G', customer: 'cus_G' };
  if (init.method === 'POST' && url.endsWith('/payment_intents')) {
    const k = init.headers['Idempotency-Key'];
    if (!S.keys[k]) { const id = 'pi_' + (S.charges.length + 1); S.charges.push(id + ' $' + Number(new URLSearchParams(init.body).get('amount')) / 100); S.keys[k] = { id, status: 'succeeded' }; }
    if (${loseAnswer ? 'true' : 'false'}) throw new Error('connection reset');
    return S.keys[k];
  }
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body)} };`);
  Object.assign(stripe, r.tables.__stripe);
  return r;
}
function callPaymentsCharge(body, loseAnswer) {
  const r = runEdge('payments-charge', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', name: 'Camp One', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', byopCustomerRef: 'tok_G' } });
const K = ${JSON.stringify(ck)}; T.tables.__ck = K;
T.rpc.claim_refund_intent = (a: any) => { const c = K.claims[a.p_key]; if (c) return { claimed: false, previous: c.result || {} }; K.claims[a.p_key] = { result: null }; return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { K.claims[a.p_key].result = a.p_result; return true; };
T.rpc.release_refund_intent = (a: any) => { delete K.claims[a.p_key]; return true; };
T.rpc.release_stale_refund_intent = () => true;
T.rpc.record_processor_transaction = () => ({ success: true });
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Asale')) { const id = 'R' + (K.sales.length + 1); K.sales.push(id + ' $' + new URLSearchParams(init.body).get('xAmount'));
    if (${loseAnswer ? 'true' : 'false'}) throw new Error('connection reset');
    return 'xResult=A&xStatus=Approved&xRefNum=' + id; }
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body)} };`);
  Object.assign(ck, r.tables.__ck);
  return r;
}

function page(fam, send) {
  const store = {}; const toasts = []; const rows = [];
  let lose = false;
  const ctx = {
    families: { gold: fam }, finPayments: rows, curPage: 'billing',
    toast: (t) => toasts.push(t), save: () => {}, renderBilling: () => {}, renderFamilyDetailPage: () => {},
    _postPaymentEntry: () => true, fm: (n) => '$' + n, esc: (s) => s, getCampId: () => 'camp1',
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    window: { confirm: (m) => { toasts.push('CONFIRM? ' + m.split('\n')[0]); return false; } },
    callEdgeFunctionAuthed: async (fn, body) => {
      const r = send(fn, body, lose);
      if (r.status >= 500 || (r.body && r.body.error && !r.body.uncertain && !r.body.declined && r.status !== 200)) { const e = new Error(r.body.error || 'x'); e.status = r.status; e.noAnswer = r.status >= 500; throw e; }
      if (r.body && r.body.error) { const e = new Error(r.body.error); e.data = r.body; throw e; }
      return r.body;
    },
  };
  const charge = new Function(...Object.keys(ctx), SRC + '; return chargeStoredCard;')(...Object.values(ctx));
  return { charge, toasts, rows, setLose: (v) => { lose = v; } };
}

test('Stripe: a same-amount charge later the same day after a lost answer', async () => {
  const p = page({ name: 'Gold', stripeCustomerId: 'cus_G', stripePaymentMethodId: 'pm_G' },
    (fn, body, lose) => callStripeCharge(body, lose));
  p.setLose(true);
  const r1 = await p.charge('gold', 500, 'Camp payment — Gold');
  console.log(`  10:00 press → ok=${r1.ok} uncertain=${r1.uncertain} | toast: ${p.toasts.slice(-1)[0].slice(0, 90)}`);
  p.setLose(false);
  const r2 = await p.charge('gold', 500, 'Late pickup fee — Gold');
  console.log(`  15:00 press (a NEW $500) → ok=${r2.ok} | toast: ${p.toasts.slice(-1)[0]}`);
  console.log(`  Stripe charges actually made: ${JSON.stringify(stripe.charges)} | payment rows the page added: ${JSON.stringify(p.rows.map(x => x.reference + ' $' + x.amount))}`);
});

test('Cardknox: the same', async () => {
  const p = page({ name: 'Gold', byopCustomerRef: 'tok_G', byopProcessor: 'cardknox' },
    (fn, body, lose) => callPaymentsCharge(body, lose));
  p.setLose(true);
  const r1 = await p.charge('gold', 500, 'Camp payment — Gold');
  console.log(`  10:00 press → ok=${r1.ok} uncertain=${r1.uncertain} | toast: ${p.toasts.slice(-1)[0].slice(0, 90)}`);
  p.setLose(false);
  const r2 = await p.charge('gold', 500, 'Late pickup fee — Gold');
  console.log(`  15:00 press (a NEW $500) → ok=${r2.ok} | messages: ${JSON.stringify(p.toasts.slice(1))}`);
  console.log(`  Sola sales actually made: ${JSON.stringify(ck.sales)} | payment rows the page added: ${JSON.stringify(p.rows.map(x => x.reference + ' $' + x.amount))}`);
});
