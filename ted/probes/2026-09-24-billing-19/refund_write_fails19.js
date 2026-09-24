// Probe (19th pass, hunt). The REAL stripe-webhook (e8f1d26) in the edge
// harness. The database answers with an ERROR (busy / timeout / not reachable)
// when the webhook books:
//   R1  a tuition refund made in the Stripe dashboard (charge.refunded → record_external_refund)
//   R2  a tuition chargeback (charge.dispute.created → record_chargeback)
//   R3  a won dispute (charge.dispute.closed won → resolve_chargeback)
//   R4  control: a canteen top-up refund (record_canteen_stripe_reversal) — 287's path
//   R5  control: a payment (append_camp_payment) — TED-164's path
// Is the delivery answered 500 so Stripe sends it again (as for R4/R5), or 200
// and the money never reaches the books?
'use strict';
const crypto = require('node:crypto');
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const C = 'c0000000-0000-0000-0000-000000000019';
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
function deliver(event, stripe) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_ted').update(`${t}.${body}`).digest('hex');
  const scen = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_WEBHOOK_SECRET: 'whsec_ted', RESEND_API_KEY: 're_test' };
T.tables.camps = [{ id: '${C}', payment_processor_key: 'stripe' }];
const busy = () => { throw new Error('canceling statement due to statement timeout'); };
for (const n of ['record_external_refund', 'record_chargeback', 'resolve_chargeback', 'record_canteen_stripe_reversal', 'append_camp_payment', 'credit_canteen_balance_from_stripe'])
  T.rpc[n] = busy;
T.rpc.camp_families_object = () => ({});
const ST: any = ${JSON.stringify(stripe || {})};
T.fetch = async (url: string) => { for (const k of Object.keys(ST)) if (url.includes(k)) return ST[k]; return { __status: 404, error: { message: 'No such object' } }; };
T.requests = [{ headers: { 'stripe-signature': 't=${t},v1=' + ${JSON.stringify(sig)} }, rawBody: ${JSON.stringify(body)} }];`;
  const r = runEdges(['stripe-webhook'], scen);
  return { status: r.responses[0].status, rpcs: (r.rpcs || []).map(x => x.name), log: (r.logs || []).join(' | ').slice(0, 400) };
}
const now = Math.floor(Date.now() / 1000);
const FAM = { campId: C, familyKey: 'gold', familyName: 'Gold' };
const CAN = { campId: C, source: 'campistry-canteen-deposit', camperId: '1', camperName: 'Avi Gold' };
const re = (id, amt) => ({ id, object: 'refund', amount: amt, status: 'succeeded', metadata: {} });
try {
  const s1 = { '/refunds/re_1': re('re_1', 50000), '/payment_intents/pi_1': { id: 'pi_1', metadata: FAM } };
  const r1 = deliver({ id: 'evt_1', type: 'charge.refunded', created: now, data: { object: { id: 'ch_1', object: 'charge', amount: 50000, amount_refunded: 50000, payment_intent: 'pi_1', metadata: FAM, refunds: { data: [re('re_1', 50000)] } } } }, s1);
  console.log(`R1 tuition dashboard refund, database busy → HTTP ${r1.status}\n    ${r1.log}`);
  check(r1.status >= 500, 'R1 answered 500 so Stripe sends it again', `HTTP ${r1.status}: the $500 refund is never booked; the family's bill still counts money it no longer paid`);

  const dp = { id: 'dp_2', object: 'dispute', amount: 50000, charge: 'ch_2', payment_intent: 'pi_2', reason: 'fraudulent', status: 'needs_response', metadata: {} };
  const s2 = { '/payment_intents/pi_2': { id: 'pi_2', metadata: FAM } };
  const r2 = deliver({ id: 'evt_2', type: 'charge.dispute.created', created: now, data: { object: dp } }, s2);
  console.log(`R2 tuition chargeback, database busy → HTTP ${r2.status}\n    ${r2.log}`);
  check(r2.status >= 500, 'R2 answered 500 so Stripe sends it again', `HTTP ${r2.status}`);

  const r3 = deliver({ id: 'evt_3', type: 'charge.dispute.closed', created: now, data: { object: { ...dp, status: 'won' } } }, s2);
  console.log(`R3 tuition dispute won, database busy → HTTP ${r3.status}\n    ${r3.log}`);
  check(r3.status >= 500, 'R3 answered 500 so Stripe sends it again', `HTTP ${r3.status}`);

  const s4 = { '/refunds/re_4': re('re_4', 2000), '/payment_intents/pi_4': { id: 'pi_4', metadata: CAN } };
  const r4 = deliver({ id: 'evt_4', type: 'charge.refunded', created: now, data: { object: { id: 'ch_4', object: 'charge', amount: 2000, amount_refunded: 2000, payment_intent: 'pi_4', metadata: CAN, refunds: { data: [re('re_4', 2000)] } } } }, s4);
  console.log(`R4 control: canteen dashboard refund, database busy → HTTP ${r4.status}`);
  check(r4.status >= 500, 'R4 control 500', `HTTP ${r4.status}`);

  const r5 = deliver({ id: 'evt_5', type: 'payment_intent.succeeded', created: now, data: { object: { id: 'pi_5', object: 'payment_intent', amount: 50000, amount_received: 50000, status: 'succeeded', payment_method_types: ['card'], metadata: FAM } } });
  console.log(`R5 control: tuition payment, database busy → HTTP ${r5.status}`);
  check(r5.status >= 500, 'R5 control 500', `HTTP ${r5.status}`);
} catch (e) {
  check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
}
console.log(`\n${bad} BAD`);
