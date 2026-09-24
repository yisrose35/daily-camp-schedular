// Probe (10th pass, TED-114 re-check): the real stripe-webhook, correctly
// signed. The dispute's own metadata is empty (as Stripe sends it), so the
// webhook now asks Stripe for the PaymentIntent / charge. What if THAT call has
// a hiccup (Stripe 500, a rate limit, a dropped connection)? Stripe only
// re-sends an event when the webhook answers non-2xx.
// Also charge.refunded without its refunds list (newer API versions) when the
// /refunds lookup has the same hiccup.
// Run: node --test ted/probes/2026-09-24-billing-10/dispute_lookup_fails.test.js
'use strict';
const test = require('node:test');
const crypto = require('node:crypto');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness.js');

function signed(event, fetchSrc) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
  return runEdge('stripe-webhook', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.rpc.record_chargeback = (a: any) => ({ success: true, entryId: 'le_cb_' + a.p_dispute_id });
T.rpc.resolve_chargeback = () => ({ success: true });
T.rpc.record_external_refund = () => ({ success: true });
T.fetch = ${fetchSrc};
T.request = { headers: { 'stripe-signature': 't=${t},v1=${sig}' }, rawBody: ${JSON.stringify(body)} };`);
}
const dispute = { id: 'evt_1', type: 'charge.dispute.created', data: { object: {
  id: 'dp_1', object: 'dispute', amount: 50000, currency: 'usd', charge: 'ch_1', payment_intent: 'pi_1',
  reason: 'fraudulent', status: 'needs_response', metadata: {}, evidence_details: { due_by: 1790000000 } } } };
const refunded = { id: 'evt_2', type: 'charge.refunded', data: { object: {
  id: 'ch_1', object: 'charge', payment_intent: 'pi_1', amount_refunded: 5000, metadata: { campId: 'camp1' } } } };

const hiccups = {
  'Stripe answers 500': `(url: string) => (url.includes('api.stripe.com') ? { __status: 500, error: { type: 'api_error', message: 'An unknown error occurred' } } : {})`,
  'Stripe answers 429 (rate limit)': `(url: string) => (url.includes('api.stripe.com') ? { __status: 429, error: { type: 'rate_limit_error', message: 'Too many requests' } } : {})`,
  'the connection drops': `(url: string) => { if (url.includes('api.stripe.com')) throw new Error('connection reset'); return {}; }`,
  '(control) Stripe answers': `(url: string) => url.includes('/payment_intents/pi_1') ? { id: 'pi_1', metadata: { campId: 'camp1' } } : url.includes('/refunds?charge=ch_1') ? { data: [{ id: 're_1', amount: 5000 }] } : {}`,
};
for (const [label, src] of Object.entries(hiccups)) {
  test(`dispute, lookup: ${label}`, () => {
    const r = signed(dispute, src);
    const n = r.rpcs.filter(c => c.name === 'record_chargeback').length;
    console.log(`  dispute | ${label.padEnd(32)} → webhook answers HTTP ${r.status} (Stripe re-sends only on non-2xx) | chargebacks posted: ${n} | log: ${(r.logs.find(l => /dp_1|dispute/.test(l)) || '').slice(0, 130)}`);
  });
  test(`charge.refunded (no list), lookup: ${label}`, () => {
    const r = signed(refunded, src);
    const n = r.rpcs.filter(c => c.name === 'record_external_refund').length;
    console.log(`  refund  | ${label.padEnd(32)} → webhook answers HTTP ${r.status} | refunds posted: ${n} | logs: ${JSON.stringify(r.logs.filter(l => !/Event:/.test(l))).slice(0, 160)}`);
  });
}
