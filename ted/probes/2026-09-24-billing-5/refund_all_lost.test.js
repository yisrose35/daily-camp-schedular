// Probe (5th pass): TED-093 for "Refund everyone" on a Cardknox camp. The Snacks
// page calls payments-canteen-refund-all with an EMPTY body (campistry_snacks.js
// ~2032), so the function has no key and claims nothing. One camper's refund
// reaches Cardknox but the answer is lost; the office presses "Try Again".
'use strict';
const test = require('node:test');
const { runEdge } = require('/home/user/daily-camp-schedular/tests/edge_harness');

test('probe', () => {
    const r = runEdge('payments-canteen-refund-all', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
const tx: any[] = [{ kind: 'deposit', method: 'cardknox', byopTransactionId: 'D1', amount: 50, camper: 'Avi', camperId: 7, timestamp: 1 }];
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: 50, balanceFloor: 0 } }, transactions: tx });
const claims: Record<string, any> = {};
T.rpc.claim_refund_intent = (a: any) => { const c = claims[a.p_key]; if (c) return { claimed: false, previous: c.result || {} }; claims[a.p_key] = {}; return { claimed: true }; };
T.rpc.release_refund_intent = (a: any) => { if (claims[a.p_key] && !claims[a.p_key].result) delete claims[a.p_key]; return true; };
T.rpc.settle_refund_intent = (a: any) => { claims[a.p_key] = { result: a.p_result }; return true; };
T.rpc.record_processor_transaction = () => ({ success: true });
T.rpc.refund_canteen_deposit_from_processor = () => ({ success: true });
let n = 0;
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) {
    if (n++ === 0) throw new Error('connection reset');   // Cardknox refunded; the answer is lost
    return 'xResult=A&xRefNum=R' + n + '&xStatus=Approved';
  }
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: {} };   // exactly what Snacks sends
T.requests = [req, req];`);
    r.responses.forEach((x, i) => console.log(`# run ${i + 1}: HTTP ${x.status} ${JSON.stringify(x.body).slice(0, 260)}`));
    console.log('# refunds that reached Cardknox for Avi\'s one $50 deposit:',
        r.fetches.filter(f => String(f.body || '').includes('cc%3Arefund')).length);
});
