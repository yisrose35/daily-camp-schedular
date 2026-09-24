// Probe (13th pass, hunt): the parent's "Balance Floor" (Link → canteen
// settings, $0–$20) at the END of the summer. Avi's parent topped up $50 by
// card and set a $10 floor; Avi spent nothing. The office returns everything:
//   F1 the REAL stripe-canteen-refund-all (Refund All)
//   F2 the REAL stripe-canteen-refund (the child's own Refund, asked for $50)
//   F3 the REAL Take Out Cash rule (campistry_snacks_cash.js SnacksCash.limit)
// How much can go back to the parent, by any button?
// Run: node ted/probes/2026-09-24-billing-13/floor_left_behind.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const SnacksCash = require(R + '/campistry_snacks_cash.js');

const view = { success: true,
  accounts: { 'Avi Katz': { balance: 50, balanceFloor: 10, camperId: 7 } },
  transactions: [{ kind: 'deposit', type: 'credit', method: 'stripe', stripePaymentIntentId: 'pi_A', amount: 50, camper: 'Avi Katz', camperId: 7, timestamp: 1 }],
  holds: [] };
const scen = (body) => `T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'c1', owner: 'u-owner', payment_processor_key: 'stripe' }];
T.tables.refund_intents = [];
let __bal = 50;
T.rpc.canteen_refund_view = () => { const v = JSON.parse(${JSON.stringify(JSON.stringify(view))}); v.accounts['Avi Katz'].balance = __bal; return v; };
T.rpc.reserve_canteen_refund = (a: any) => { if (a.p_amount > __bal - 10) return { success: false, error: 'insufficient', available: __bal - 10 }; __bal -= a.p_amount; return { success: true, balance: __bal }; };
T.rpc.settle_canteen_refund_hold = () => ({ success: true });
T.rpc.release_canteen_refund_hold = () => ({ released: true });
T.rpc.claim_refund_intent = () => ({ claimed: true });
T.rpc.settle_refund_intent = () => true;
T.rpc.release_refund_intent = () => true;
T.fetch = async (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) { const p = new URLSearchParams(init.body); return { id: 're_1', object: 'refund', amount: Number(p.get('amount')), status: 'succeeded', created: Math.floor(Date.now() / 1000) }; }
  if (url.includes('/payment_intents/')) return { id: 'pi_A', transfer_data: null, metadata: { campId: 'c1' } };
  if (url.includes('/refunds?')) return { object: 'list', data: [], has_more: false };
  return {};
};
T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body)} }];`;

const all = runEdges(['stripe-canteen-refund-all'], scen({})).responses[0].body;
console.log(`F1 Refund All → refunded $${all.totalRefunded} (${JSON.stringify(all.details)})`);
const holds = runEdges(['stripe-canteen-refund'], scen({ action: 'holds' })).responses[0].body;
console.log(`   what the Refund window is told: ${JSON.stringify(holds.refundable)}`);
const one = runEdges(['stripe-canteen-refund'], scen({ camperId: 7, camperName: 'Avi Katz', amount: 50, idempotencyKey: 'cref_x' })).responses[0].body;
console.log(`F2 the child's own Refund, $50 asked → refunded $${one.totalRefunded}${one.cappedReason ? ' — "' + one.cappedReason + '"' : ''}${one.error ? ' ERROR ' + one.error : ''}`);
const cash = SnacksCash.limit({ account: { balance: 10, balanceFloor: 10 }, transactions: [], camper: 'Avi Katz', date: '2026-08-20', settings: {} });
console.log(`F3 then Take Out Cash for the $10 left → max $${cash.max} ("${cash.reason}")`);
const back = Number(all.totalRefunded) || 0;
console.log(`\n${back < 50 ? 'NOTE' : 'ok  '} of Avi's $50, $${back} can go back by card and $${cash.max} in cash; $${50 - back - cash.max} stays on the wallet`);
