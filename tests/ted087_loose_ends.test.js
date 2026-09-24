// =============================================================================
// ted087_loose_ends.test.js — TED-087, the real functions.
//
//   * A Cardknox/Sola camp cannot be connected without its webhook PIN, and a
//     notice for a camp without one is answered with an error (so Sola keeps
//     retrying) — a 200 told Sola it was delivered and the payment was lost.
//   * The nightly tip retry records the parent's payment on the tip, and does
//     not record a tip the webhook already recorded under that payment.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');

test('Cardknox cannot be connected without its webhook PIN (nothing is tested or stored)', () => {
    const r = runEdge('admin-connect-processor', `
      T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
      T.tables.camps = [{ id: 'camp1', name: 'Camp One' }];
      T.request = { headers: { Authorization: 'Bearer svc' }, body: { campId: 'camp1', processorKey: 'cardknox', credentials: { apiKey: 'k', checkoutSlug: 's' } } };`);
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /webhookPin/);
    assert.strictEqual(r.fetches.length, 0, 'the processor was called');
    assert.ok(!r.rpcs.some(x => /store|save|credential/i.test(x.name) && x.name !== '_admin_get_processor_credential'), 'something was stored');
});

test('a Sola notice for a camp with no PIN is not acknowledged (Sola retries instead of dropping it)', () => {
    const r = runEdge('cardknox-webhook', `
      T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
      T.rpc._admin_get_processor_credential = () => ({ success: true, processorKey: 'cardknox', credentials: { apiKey: 'k' } });
      T.request = { url: 'http://edge.test/fn?campId=camp1', headers: { 'ck-signature': 'x', 'content-type': 'application/x-www-form-urlencoded' }, rawBody: 'xAmount=250.00&xRefNum=9000' };`);
    assert.ok(r.status >= 500, 'answered ' + r.status + ' — Sola treats a 2xx as delivered');
});

const TIP = (tipsKnown) => `
T.env = { STRIPE_SECRET_KEY: 'sk_test_x', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.tables.camps = [{ id: 'camp1', name: 'Camp One', payment_processor_key: null }];
T.rpc.camp_payments_array = () => [];
T.rpc.flag_expiring_cards = () => ({ expired: 0, expiringSoon: 0 });
T.rpc.camp_families_object = () => ({});
T.rpc.retry_failed_tip_transfers = () => [{ id: 'item1' }];
T.tables.link_tip_cart_items = [{ id: 'item1', cart_id: 'cart1', camp_id: 'camp1', staff_account_id: 'lsa-1', staff_name: 'Dina',
    staff_role: 'counselor', stripe_account_id: 'acct_DINA', tip_cents: 2000, fee_cents: 40, processed_at: null, transfer_error: 'boom',
    parent_user_id: 'u-p', camper_name: 'Avi', person_id: 4, stripe_payment_intent_id: 'pi_parent' }];
T.tables.link_tips = ${JSON.stringify(tipsKnown)};
T.fetch = (url: string, init: any) => {
  if (init.method === 'GET' && url.includes('/transfers?')) return { data: [] };
  if (init.method === 'POST' && url.endsWith('/transfers')) return { id: 'tr_retry' };
  return {};
};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`;

test('a retried tip is recorded against the parent\'s payment', () => {
    const r = runEdge('charge-due-installments', TIP([]));
    const ins = r.writes.find(w => w.table === 'link_tips' && w.op === 'insert');
    assert.ok(ins, 'the tip was not recorded');
    assert.strictEqual(ins.payload.stripe_payment_intent_id, 'pi_parent', 'no payment on the tip — a refund or dispute lookup misses it');
});

test('a tip the webhook already recorded under that payment is not recorded twice', () => {
    const r = runEdge('charge-due-installments', TIP([{ id: 't1', stripe_payment_intent_id: 'pi_parent', staff_account_id: 'lsa-1', stripe_transfer_id: null }]));
    assert.ok(!r.writes.some(w => w.table === 'link_tips' && w.op === 'insert'), 'the tip was recorded twice');
    assert.ok(!r.rpcs.some(x => x.name === 'increment_staff_total_earned'), 'the counselor\'s total was counted twice');
});
