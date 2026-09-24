// =============================================================================
// refund_lost_answer.test.js — TED-093, the real refund functions.
//
// The office refunds $100. The card company does it, and the connection drops
// before it answers. Before: "Refund failed", the office clicked again, and the
// family got $200 back. Now the claim is kept; a retry is told to check the
// processor and sends nothing; only an explicit "nothing went through" sends it.
// On Stripe the retry re-asks with the SAME key, so Stripe answers with the
// refund it already made.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');

// migration 198's claim, as a model (pgtests cover the SQL)
const CLAIMS = `
const claims: Record<string, any> = {};
T.rpc.claim_refund_intent = (a: any) => { const c = claims[a.p_key]; if (c) return { claimed: false, previous: c.result || {} }; claims[a.p_key] = {}; return { claimed: true }; };
T.rpc.release_refund_intent = (a: any) => { if (claims[a.p_key] && !claims[a.p_key].result) delete claims[a.p_key]; return true; };
T.rpc.settle_refund_intent = (a: any) => { claims[a.p_key] = { result: a.p_result }; return true; };
T.rpc.record_processor_transaction = () => ({ success: true });
T.rpc.record_external_refund = () => ({ success: true });`;

const BYOP = (extra) => `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
${CLAIMS}
let n = 0;
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) {
    if (n++ === 0) throw new Error('connection reset');   // the gateway refunded; its answer is lost
    return 'xResult=A&xRefNum=R' + n + '&xStatus=Approved';
  }
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { externalTransactionId: 'X100', amount: 100, idempotencyKey: 'rfnd_gold:pay_1:50000:10000' } };
${extra}`;
const gatewayRefunds = r => r.fetches.filter(f => String(f.body || '').includes('cc%3Arefund')).length;

test('TED-093: a Cardknox refund whose answer was lost is not sent again on a retry', () => {
    const r = runEdge('payments-refund', BYOP(`T.requests = [req, req];`));
    const [a, b] = r.responses.map(x => x.body);
    assert.strictEqual(a.uncertain, true, 'the first try must say it may have gone through: ' + JSON.stringify(a));
    assert.strictEqual(b.uncertain, true, 'the retry must not look like a success or send again: ' + JSON.stringify(b));
    assert.ok(!b.replayed, 'an unconfirmed refund was replayed as a success');
    assert.strictEqual(gatewayRefunds(r), 1, 'the family was refunded twice');
});

test('TED-093: the office confirms nothing went through, and it is sent — once', () => {
    const r = runEdge('payments-refund', BYOP(`
      const sure = { headers: req.headers, body: Object.assign({}, req.body, { confirmNotRefunded: true }) };
      T.requests = [req, sure, req];`));
    const [, b, c] = r.responses.map(x => x.body);
    assert.strictEqual(b.externalTransactionId, 'R2', JSON.stringify(b));
    assert.strictEqual(c.replayed, true, 'after it settled, a retry replays it');
    assert.strictEqual(gatewayRefunds(r), 2);
});

test('TED-094: a negative refund amount is refused before anything is sent', () => {
    const r = runEdge('payments-refund', BYOP(`T.requests = [{ headers: req.headers, body: Object.assign({}, req.body, { amount: -50 }) }];`));
    assert.strictEqual(r.status, 400);
    assert.strictEqual(gatewayRefunds(r), 0);
});

test('TED-093: a Stripe refund whose answer was lost is re-asked with the SAME key', () => {
    const r = runEdge('stripe-refund', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'stripe', stripe_account_id: 'acct_1' }];
${CLAIMS}
let n = 0;
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) { if (n++ === 0) throw new Error('connection reset'); return { id: 're_1', status: 'succeeded', amount: 10000 }; }
  if (url.includes('/payment_intents/')) return { id: 'pi_1', amount: 50000, latest_charge: 'ch_1', transfer_data: null, metadata: { campId: 'camp1' } };
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { paymentIntentId: 'pi_1', amount: 100, idempotencyKey: 'rfnd_gold:pay_1:50000:10000' } };
T.requests = [req, req];`);
    const posts = r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/refunds'));
    assert.strictEqual(posts.length, 2, JSON.stringify(r.responses));
    assert.strictEqual(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key'],
        'a retry used a new key — Stripe would refund twice');
    assert.strictEqual(r.responses[1].body.refundId, 're_1', JSON.stringify(r.responses[1].body));
});
