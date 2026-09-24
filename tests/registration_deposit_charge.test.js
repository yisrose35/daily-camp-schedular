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
// migration 268's claim, as a model (scripts/pgtests/268 tests the SQL). Each
// claim moves the clock on T.gap minutes, so a test can make a claim stale.
const claims: Record<string, any> = {};
let clock = 0; T.gap = 0;
T.rpc.claim_charge_intent = (a: any) => {
  clock += T.gap;
  const c = claims[a.p_key];
  if (!c) { claims[a.p_key] = { at: clock, attempt: 0 }; return { claimed: true, state: 'new', attempt: 0 }; }
  if (c.settled) return { claimed: false, state: 'settled', previous: c.result };
  if (c.released || (c.called == null && clock - c.at >= 10) || (a.p_take_stale && c.called != null && clock - c.called >= 10)) {
    c.released = false; c.at = clock; return { claimed: true, state: 'retaken', attempt: c.attempt };
  }
  if (c.called != null && clock - c.called >= 10) return { claimed: false, state: 'stale', attempt: c.attempt };
  return { claimed: false, state: 'in_progress', attempt: c.attempt };
};
T.rpc.mark_charge_intent_called = (a: any) => { claims[a.p_key].called = clock; return true; };
T.rpc.settle_refund_intent = (a: any) => { claims[a.p_key].settled = true; claims[a.p_key].result = a.p_result; return true; };
T.rpc.release_charge_intent = (a: any) => { const c = claims[a.p_key]; if (c && !c.settled) { c.released = true; c.called = null; if (a.p_declined) c.attempt++; } return true; };
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

const OFFICE_REQ = `const req = { headers: { Authorization: 'Bearer owner' }, body: { campId: 'camp1', enrollmentId: 'enr_1', returnUrl: 'https://camp.test/', officeCharge: true } };`;
const idem = r => charges(r).map(c => c.headers['Idempotency-Key']);

test('TED-083: a Cardknox charge cut off mid-way is never reported as paid, and the office can finish it', () => {
    const r = runEdge('registration-deposit-checkout', W('cardknox') + `
      T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
      let n = 0;
      T.fetch = (url: string) => { if (url.includes('cardknox')) { if (n++ === 0) throw new Error('connection reset'); return 'xResult=A&xRefNum=77'; } return {}; };
      ${OFFICE_REQ}
      T.requests = [req, req, { ...req, body: { ...req.body } }, { ...req, body: { ...req.body, confirmNotCharged: true } }];
      const orig = T.rpc.claim_charge_intent; let k = 0;
      T.rpc.claim_charge_intent = (a: any) => { T.gap = k++ >= 2 ? 11 : 0; return orig(a); };`);
    const b = r.responses.map(x => x.body);
    assert.strictEqual(b[0].success, false, 'try 1 was cut off');
    for (const x of b.slice(0, 3)) assert.ok(!x.alreadyPaid && !x.paid, 'a cut-off charge was reported as paid: ' + JSON.stringify(x));
    assert.strictEqual(b[1].reason, 'in_progress', JSON.stringify(b[1]));
    assert.strictEqual(b[2].reason, 'needs_check', 'after 10 minutes the office is asked to check: ' + JSON.stringify(b[2]));
    assert.strictEqual(b[3].paid, true, 'the office confirmed nothing went through, and it was not charged: ' + JSON.stringify(b[3]));
    assert.strictEqual(r.fetches.filter(f => f.url.includes('cardknox')).length, 2, 'the card company was asked more than twice');
});

test('TED-083: a Stripe charge cut off mid-way is re-asked with the SAME key (Stripe says what happened)', () => {
    const r = runEdge('registration-deposit-checkout', W(null) + `
      let n = 0;
      T.fetch = (url: string) => { if (url.endsWith('/payment_intents')) { if (n++ === 0) throw new Error('connection reset'); return { id: 'pi_1', status: 'succeeded', amount_received: 25000 }; } return {}; };
      ${OFFICE_REQ}
      T.requests = [req, req];`);
    assert.strictEqual(r.responses[0].body.success, false);
    assert.ok(!r.responses[0].body.alreadyPaid);
    assert.strictEqual(r.responses[1].body.paid, true, JSON.stringify(r.responses[1].body));
    const k = idem(r);
    assert.strictEqual(k.length, 2);
    assert.strictEqual(k[0], k[1], 'a retry after a lost answer must re-ask Stripe with the same key');
});

test('TED-085: a retry after a decline is a NEW Stripe request (a new Idempotency-Key)', () => {
    const r = runEdge('registration-deposit-checkout', W(null) + `
      let n = 0;
      T.fetch = (url: string) => url.endsWith('/payment_intents') ? (n++ === 0 ? { __status: 402, error: { type: 'card_error', message: 'Your card was declined.' } } : { id: 'pi_ok', status: 'succeeded', amount_received: 25000 }) : {};
      ${OFFICE_REQ}
      T.requests = [req, req, req];`);
    assert.strictEqual(r.responses[0].body.success, false);
    assert.strictEqual(r.responses[1].body.paid, true);
    assert.strictEqual(r.responses[2].body.alreadyPaid, true, 'only a settled claim is "already paid"');
    const k = idem(r);
    assert.strictEqual(k.length, 2);
    assert.notStrictEqual(k[0], k[1], 'Stripe would replay the decline for 24 hours');
});

test('TED-083: a charge still running is "in progress", never "already paid"', () => {
    const r = runEdge('registration-deposit-checkout', W(null) + `
      ${OFFICE_REQ}
      T.requests = [req];
      T.rpc.claim_charge_intent = () => ({ claimed: false, state: 'in_progress', attempt: 0 });`);
    assert.strictEqual(r.body.success, false);
    assert.strictEqual(r.body.inProgress, true);
    assert.ok(!r.body.alreadyPaid);
    assert.strictEqual(charges(r).length, 0);
});

test('TED-089: "charge deposit now" finds an application still in camp_applications', () => {
    const r = runEdge('registration-deposit-checkout', W(null) + `
      T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: {} } }];
      T.tables.camp_applications = [{ camp_id: 'camp1', kind: 'enrollments', entry_id: 'enr_1', payload: { camperName: 'Avi',
         savedCardCustomer: 'cus_parent', savedCardMethod: 'pm_parent', savedCardProcessor: 'stripe', savedCardLast4: '4242' } }];
      ${OFFICE_REQ}
      T.requests = [req];`);
    assert.strictEqual(r.body.paid, true, JSON.stringify(r.body));
    assert.strictEqual(charges(r).length, 1);
});
