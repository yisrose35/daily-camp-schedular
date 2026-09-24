// Proof (4th pass): a Cardknox refund whose answer is lost (the gateway DID refund,
// then the connection dropped). payments-refund treats that as "no money moved",
// gives the claim back, and the office's retry — same idempotency key — refunds again.
// The claim functions are modelled on 198 (claim_refund_intent / release / settle).
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');
test('probe', () => {
  const r = runEdge('payments-refund', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
const claims: Record<string, any> = {};
T.rpc.claim_refund_intent = (a: any) => { const c = claims[a.p_key]; if (c) return { claimed: false, previous: c.result || {} }; claims[a.p_key] = {}; return { claimed: true }; };
T.rpc.release_refund_intent = (a: any) => { delete claims[a.p_key]; return true; };
T.rpc.settle_refund_intent = (a: any) => { claims[a.p_key] = { result: a.p_result }; return true; };
T.rpc.record_processor_transaction = () => ({ success: true });
T.rpc.record_external_refund = () => ({ success: true });
let refundsAtGateway = 0, n = 0;
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund') || String(init.body || '').includes('cc:refund')) {
    refundsAtGateway++;                                   // the gateway refunds...
    if (n++ === 0) throw new Error('connection reset');   // ...and the first answer is lost
    return 'xResult=A&xRefNum=R' + n + '&xStatus=Approved';
  }
  return {};
};
(globalThis as any).__count = () => refundsAtGateway;
const req = { headers: { Authorization: 'Bearer owner' }, body: { externalTransactionId: 'X100', amount: 100, idempotencyKey: 'refund:pay_1:100' } };
T.requests = [req, req];`);
  r.responses.forEach((x, i) => console.log('office try ' + (i + 1) + ':', x.status, JSON.stringify(x.body)));
  console.log('refund calls that reached the gateway (each one moves money):', r.fetches.filter(f => String(f.body || '').includes('refund')).length);
});
