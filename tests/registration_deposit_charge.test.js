// =============================================================================
// registration_deposit_charge.test.js — the real registration-deposit-checkout.
//
//   TED-069  the office's "charge deposit now" needs an owner/admin login (it
//            charged a parent's saved card for anyone with two ids), and two
//            requests at once charge the deposit once.
//   TED-070  a Banquest camp's hosted deposit page finds the camp's keys, and
//            a Banquest charge goes to the camp's own gateway address.
//   TED-076  a Stripe deposit carries the camp as the statement name and an
//            Idempotency-Key.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');

const W = (processor) => `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner', counselor: 'u-counselor' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: ${processor ? `'${processor}'` : 'null'}, stripe_account_id: 'acct_1', stripe_charges_enabled: true }];
T.tables.camp_users = [{ user_id: 'u-counselor', camp_id: 'camp1', role: 'counselor', accepted_at: '2026-01-01' }];
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: { enr_1: { camperName: 'Avi',
   savedCardCustomer: ${processor === 'banquest' ? "'tok_1'" : "'cus_parent'"}, savedCardMethod: ${processor === 'banquest' ? "'tok_1'" : "'pm_parent'"},
   savedCardProcessor: '${processor || 'stripe'}', savedCardLast4: '4242' } } } }];
T.rpc._registration_deposit_owed = () => ({ success: true, owed: 250, label: 'Deposit', camperName: 'Avi' });
T.rpc._record_registration_deposit = () => ({ success: true });
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { sourceKey: 'sk', pin: '1', paymentPageSlug: 'slug1', gatewayUrl: 'https://sandbox.banquest.test/api/v2' } });
const claims: Record<string, any> = {};
T.rpc.claim_refund_intent = (a: any) => { if (claims[a.p_key]) return { claimed: false, previous: claims[a.p_key] }; claims[a.p_key] = {}; return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { claims[a.p_key] = a.p_result; return true; };
T.rpc.release_refund_intent = (a: any) => { delete claims[a.p_key]; return true; };
T.fetch = (url: string) => {
  if (url.endsWith('/payment_intents')) return { id: 'pi_' + T.fetches.length, status: 'succeeded', amount_received: 25000 };
  if (url.includes('/transactions/charge')) return { status_code: 'A', status: 'Approved', reference_number: 555 };
  if (url.includes('/payment-pages/generate-pay-link/')) return { url: 'https://pay.banquest.test/p/1' };
  return {};
};
`;
const charges = r => r.fetches.filter(f => f.method === 'POST' && (f.url.endsWith('/payment_intents') || f.url.includes('/transactions/charge')));
const office = (auth) => `T.request = { headers: ${auth ? `{ Authorization: 'Bearer ${auth}' }` : '{}'}, body: { campId: 'camp1', enrollmentId: 'enr_1', returnUrl: 'https://camp.test/', officeCharge: true } };`;

test('TED-069: "charge deposit now" with no login, or from a counselor, charges nothing', () => {
    for (const who of ['', 'counselor']) {
        const r = runEdge('registration-deposit-checkout', W(null) + office(who));
        assert.strictEqual(r.status, 403, who || 'no login');
        assert.strictEqual(charges(r).length, 0, 'a saved card was charged for ' + (who || 'nobody'));
    }
});

test('TED-069: the owner charges the deposit; the same request twice charges once', () => {
    const r = runEdge('registration-deposit-checkout', W(null) + `
      const req = { headers: { Authorization: 'Bearer owner' }, body: { campId: 'camp1', enrollmentId: 'enr_1', returnUrl: 'https://camp.test/', officeCharge: true } };
      T.requests = [req, req];`);
    assert.strictEqual(r.responses[0].body.paid, true, JSON.stringify(r.responses[0].body));
    assert.strictEqual(charges(r).length, 1, 'the deposit was charged twice');
    assert.strictEqual(r.responses[1].body.alreadyPaid, true);
});

test('TED-076: a Stripe deposit names the camp on the statement and carries an Idempotency-Key', () => {
    const r = runEdge('registration-deposit-checkout', W(null) + office('owner'));
    const c = charges(r)[0];
    const p = new URLSearchParams(c.body);
    assert.strictEqual(p.get('on_behalf_of'), 'acct_1');
    assert.strictEqual(p.get('transfer_data[destination]'), 'acct_1');
    assert.ok(c.headers['Idempotency-Key']);
});

test('TED-070: a Banquest deposit is charged at the camp\'s own gateway address', () => {
    const r = runEdge('registration-deposit-checkout', W('banquest') + office('owner'));
    assert.strictEqual(r.body.paid, true, JSON.stringify(r.body));
    assert.ok(charges(r)[0].url.startsWith('https://sandbox.banquest.test/api/v2/'), charges(r)[0].url);
});

test('TED-070: a Banquest camp\'s hosted deposit page finds the camp\'s keys', () => {
    const r = runEdge('registration-deposit-checkout', W('banquest') + `T.request = { body: { campId: 'camp1', enrollmentId: 'enr_1', returnUrl: 'https://camp.test/' } };`);
    assert.notStrictEqual(r.body.reason, 'banquest_not_configured', 'the Banquest keys were not found');
    assert.ok(r.fetches.some(f => f.url.includes('/payment-pages/generate-pay-link/slug1')), 'no pay page was asked for');
});

test('a declined deposit releases its claim, so the parent can try again', () => {
    const r = runEdge('registration-deposit-checkout', W(null) + `
      let n = 0;
      T.fetch = (url: string) => url.endsWith('/payment_intents') ? (n++ === 0 ? { error: { message: 'Your card was declined.' } } : { id: 'pi_ok', status: 'succeeded', amount_received: 25000 }) : {};
      const req = { headers: { Authorization: 'Bearer owner' }, body: { campId: 'camp1', enrollmentId: 'enr_1', returnUrl: 'https://camp.test/', officeCharge: true } };
      T.requests = [req, req];`);
    assert.strictEqual(r.responses[0].body.success, false);
    assert.strictEqual(r.responses[1].body.paid, true, 'the retry after a decline was refused');
    assert.strictEqual(charges(r).length, 2);
});
