// Probe (9th pass, new hunt). Me → Billing → a family → "Charge Card".
// The office charges a family's saved card $500. The card company takes the
// money, but the answer never gets back (a dropped connection or a timeout).
// The page says "Charge failed: …". The office presses Charge Card again.
//
// Part 1 — the REAL chargeStoredCard (cut from campistry_me.js) with a fake
// page: what key does each press send?
// Part 2 — the REAL stripe-charge / payments-charge, both presses in a row,
// against a card company modelled as it behaves (Stripe replays a repeated
// Idempotency-Key; Cardknox has none; the first answer is lost after the money
// moved). How many times is the parent charged?
// Part 3 — Banquest answering 504 with no body (its gateway timed out; the sale
// may or may not have gone through): what does payments-charge tell the office?
// Run: node --test ted/probes/2026-09-24-billing-9/office_charge_retry.test.js
'use strict';
const test = require('node:test');
const fs = require('node:fs');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');

test('part 1: the key each press of Charge Card sends', async () => {
  const src = fs.readFileSync('/home/user/daily-camp-schedular/campistry_me.js', 'utf8');
  const m = src.match(/async function chargeStoredCard\(famKey,amount,description,quiet\)\{[\s\S]*?\n\}\n/);
  const sent = []; const toasts = [];
  let call = 0;
  const ctx = {
    families: { gold: { name: 'Gold', stripeCustomerId: 'cus_G', stripePaymentMethodId: 'pm_G' } },
    finPayments: [], curPage: 'billing',
    toast: (t) => toasts.push(t), save: () => {}, renderBilling: () => {}, renderFamilyDetailPage: () => {},
    _postPaymentEntry: () => true, fm: (n) => '$' + n, esc: (s) => s,
    callEdgeFunctionAuthed: async (fn, body) => {
      sent.push(fn + ' key=' + body.idempotencyKey);
      if (++call === 1) throw new Error('Failed to send a request to the Edge Function');   // answer lost
      return { paymentIntentId: 'pi_2', status: 'succeeded', amount: 500 };
    },
  };
  const f = new Function(...Object.keys(ctx), m[0] + '; return chargeStoredCard;')(...Object.values(ctx));
  await f('gold', 500, 'Camp payment');
  await f('gold', 500, 'Camp payment');   // the office tries again after "Charge failed"
  console.log('# part 1: office saw ' + JSON.stringify(toasts.filter(t => /fail|Charged/.test(t))));
  console.log('# part 1: keys sent: ' + sent.join(' | '));
});

test('part 2a: Stripe — answer lost, office presses again', () => {
  const r = runEdge('stripe-charge', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', name: 'Camp One', stripe_account_id: 'acct_CAMP', stripe_charges_enabled: true }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', stripeCustomerId: 'cus_G' } });
const made: Record<string, any> = {}; let n = 0, posts = 0; T.tables.__charged = [];
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_methods/')) return { id: 'pm_G', customer: 'cus_G' };
  if (init.method === 'POST' && url.endsWith('/payment_intents')) {
    posts++;
    const k = init.headers['Idempotency-Key'];
    if (!made[k]) { n++; made[k] = { id: 'pi_' + n, status: 'succeeded' }; T.tables.__charged.push('pi_' + n + ' $' + Number(new URLSearchParams(init.body).get('amount')) / 100); }
    if (posts === 1) throw new Error('connection reset');     // Stripe charged; the answer is lost
    return made[k];
  }
  return {};
};
const press = (key: string) => ({ headers: { Authorization: 'Bearer owner' }, body: { customerId: 'cus_G', paymentMethodId: 'pm_G', amount: 500, metadata: { familyKey: 'gold' }, idempotencyKey: key } });
T.requests = [press('chg_gold_1727000000000_ab12cd'), press('chg_gold_1727000009000_ef34gh')];`);
  console.log('# part 2a Stripe: answers ' + JSON.stringify(r.responses.map(x => x.status + ' ' + (x.body.error || x.body.status))) + ' | the parent was charged: ' + JSON.stringify(r.tables.__charged));
});

test('part 2b: Cardknox — answer lost, office presses again', () => {
  const r = runEdge('payments-charge', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', byopCustomerRef: 'tok_G' } });
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
T.tables.refund_intents = [];
T.rpc.claim_refund_intent = (a: any) => { const c = T.tables.refund_intents.find((r: any) => r.key === a.p_key); if (c) return { claimed: false, previous: c.result || {} }; T.tables.refund_intents.push({ key: a.p_key, result: null }); return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { const c = T.tables.refund_intents.find((r: any) => r.key === a.p_key); if (c) c.result = a.p_result; return true; };
T.rpc.release_refund_intent = (a: any) => { T.tables.refund_intents = T.tables.refund_intents.filter((r: any) => r.key !== a.p_key); return true; };
let n = 0; T.tables.__charged = [];
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Asale')) {
    n++; T.tables.__charged.push('sale ' + n + ' $' + new URLSearchParams(init.body).get('xAmount'));
    if (n === 1) throw new Error('connection reset');        // Cardknox charged; the answer is lost
    return 'xResult=A&xRefNum=' + (9000 + n) + '&xStatus=Approved';
  }
  return {};
};
const press = (key: string) => ({ headers: { Authorization: 'Bearer owner' }, body: { customerRef: 'tok_G', amount: 500, familyKey: 'gold', idempotencyKey: key } });
T.requests = [press('chg_gold_1727000000000_ab12cd'), press('chg_gold_1727000009000_ef34gh')];`);
  console.log('# part 2b Cardknox: answers ' + JSON.stringify(r.responses.map(x => x.status + ' ' + (x.body.error || x.body.status))) + ' | the parent was charged: ' + JSON.stringify(r.tables.__charged));
});

test('part 3: Banquest gateway times out (504, no body)', () => {
  const r = runEdge('payments-charge', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'banquest' }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', byopCustomerRef: '123' } });
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { sourceKey: 's', pin: 'p' } });
T.tables.refund_intents = [];
T.rpc.claim_refund_intent = (a: any) => { T.tables.refund_intents.push({ key: a.p_key }); return { claimed: true }; };
T.rpc.release_refund_intent = (a: any) => { T.tables.refund_intents = T.tables.refund_intents.filter((r: any) => r.key !== a.p_key); T.tables.__released = [a.p_key]; return true; };
T.fetch = (url: string) => url.endsWith('/transactions/charge') ? { __status: 504 } : {};
T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerRef: '123', amount: 500, familyKey: 'gold', idempotencyKey: 'chg_1' } };`);
  console.log('# part 3 Banquest 504: office is told ' + JSON.stringify(r.body) + ' | claim released: ' + JSON.stringify(r.tables.__released || []));
});
