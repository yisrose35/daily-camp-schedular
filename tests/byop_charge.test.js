// =============================================================================
// byop_charge.test.js — TED-054. payments-charge (the office's "Charge card on
// file" for Banquest and Cardknox/Sola camps) imported a file that does not
// exist next to it, so it could never start. It is now self-contained; this
// runs the real function against a pretend gateway and database.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runEdge } = require('./edge_harness');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/payments-charge/index.ts'), 'utf8');

const WORLD = (processor) => `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner', counselor: 'u-counselor' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: '${processor}' }];
T.tables.camp_users = [{ user_id: 'u-counselor', camp_id: 'camp1', role: 'counselor', accepted_at: '2026-01-01' }];
T.rpc.camp_families_object = () => ({ fam1: { name: 'Gold', byopCustomerRef: 'tok_gold' } });
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck_key', sourceKey: 'sk', pin: '1234' } });
const claims: Record<string, any> = {};
T.rpc.claim_refund_intent = (a: any) => { if (claims[a.p_key]) return { claimed: false, previous: claims[a.p_key] }; claims[a.p_key] = {}; return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { claims[a.p_key] = a.p_result; return true; };
T.rpc.release_refund_intent = (a: any) => { delete claims[a.p_key]; return true; };
T.fetch = (url: string, init: any) => {
  if (url.includes('cardknox')) return (init.body.includes('xToken=tok_decline') ? 'xResult=D&xError=Declined&xStatus=Declined' : 'xResult=A&xRefNum=9001&xStatus=Approved');
  if (url.includes('/transactions/charge')) return { status_code: 'A', status: 'Approved', reference_number: 7001 };
  return {};
};
`;
const gatewayCalls = r => r.fetches.filter(f => /cardknox|transactions\/charge/.test(f.url));

test('TED-054: the function imports nothing it cannot deploy with', () => {
    const imports = SRC.match(/^import .* from .*$/gm) || [];
    assert.ok(imports.every(l => /https:\/\//.test(l)), 'a local import remains: ' + imports.join(' | '));
});

test('TED-054: a Cardknox camp\'s office charges a family\'s saved card', () => {
    const r = runEdge('payments-charge', WORLD('cardknox') + `T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerRef: 'tok_gold', amount: 125.5, idempotencyKey: 'chg_1' } };`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.externalTransactionId, '9001');
    const g = gatewayCalls(r);
    assert.strictEqual(g.length, 1);
    const p = new URLSearchParams(g[0].body);
    assert.strictEqual(p.get('xAmount'), '125.50');
    assert.strictEqual(p.get('xToken'), 'tok_gold');
    assert.ok(r.rpcs.some(x => x.name === 'record_processor_transaction'), 'the charge was not recorded');
});

test('TED-054: a Banquest camp\'s office charges a family\'s saved card', () => {
    const r = runEdge('payments-charge', WORLD('banquest') + `T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerRef: 'tok_gold', amount: 40 } };`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.externalTransactionId, '7001');
    const body = JSON.parse(gatewayCalls(r)[0].body);
    assert.strictEqual(body.amount, 40);
    assert.strictEqual(body.source, 'tkn-tok_gold');
});

test('the same click sent twice charges once', () => {
    const r = runEdge('payments-charge', WORLD('cardknox') + `
      const req = { headers: { Authorization: 'Bearer owner' }, body: { customerRef: 'tok_gold', amount: 10, idempotencyKey: 'chg_2' } };
      T.requests = [req, req];`);
    assert.strictEqual(gatewayCalls(r).length, 1, 'charged twice');
    assert.strictEqual(r.responses[1].body.replayed, true);
});

test('a card that is not one of this camp\'s families is refused; nothing reaches the gateway', () => {
    const r = runEdge('payments-charge', WORLD('cardknox') + `T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerRef: 'tok_stranger', amount: 10 } };`);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(gatewayCalls(r).length, 0);
});

test('no login, or a counselor, cannot charge', () => {
    for (const h of ['', 'counselor']) {
        const r = runEdge('payments-charge', WORLD('cardknox') + `T.request = { headers: ${h ? `{ Authorization: 'Bearer ${h}' }` : '{}'}, body: { customerRef: 'tok_gold', amount: 10 } };`);
        assert.strictEqual(r.status, 403);
        assert.strictEqual(gatewayCalls(r).length, 0);
    }
});

test('a decline answers with the reason and gives the claim back, so a retry can charge', () => {
    const r = runEdge('payments-charge', WORLD('cardknox') + `
      T.rpc.camp_families_object = () => ({ fam1: { byopCustomerRef: 'tok_decline' } });
      T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerRef: 'tok_decline', amount: 10, idempotencyKey: 'chg_3' } };`);
    assert.strictEqual(r.status, 200);
    assert.match(String(r.body.error), /Declined/);
    assert.ok(r.rpcs.some(x => x.name === 'release_refund_intent'), 'the claim was not released after a decline');
});
