// =============================================================================
// canteen_autoreload_season.test.js — TED-143, the real functions.
//
// A parent turns on auto-reload and leaves the dates blank (how the form
// starts). Camp ends; the office runs Refund All; the next run of the
// auto-reload job charged the parent's card again — every day after a refund,
// every week on a weekly reload — because nothing knew the season was over and
// the office had no way to switch it off.
//
// Now: the camp's end date and the office's switch (Snacks → Settings) stop
// the runner for the whole camp, and a refund that empties a wallet switches
// that child's auto-reload off.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');
const { HOLDS } = require('./canteen_wallet_model');

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

function nightly({ campDates, snacksSettings }) {
    return runEdge('canteen-auto-reload', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'c' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: null }];
T.tables.camp_state_kv = [
  ${campDates ? `{ camp_id: 'camp1', key: 'campDates', value: ${JSON.stringify(campDates)} },` : ''}
  ${snacksSettings ? `{ camp_id: 'camp1', key: 'campistrySnacks', value: { settings: ${JSON.stringify(snacksSettings)} } },` : ''}
];
const ar: any = { enabled: true, cardOnFile: true, stripeCustomerId: 'cus_P', thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20 };
T.rpc.canteen_autoreload_accounts = () => [{ camp_id: 'camp1', resolvable: true, person_id: 7, camper_name: 'Avi', account: { balance: 0, autoReload: ar } }];
T.rpc.update_canteen_autoreload_state = () => ({ success: true });
T.rpc.claim_refund_intent = () => ({ claimed: true });
T.rpc.release_refund_intent = () => true;
T.fetch = (url: string) => url.endsWith('/payment_intents') ? { id: 'pi_1', status: 'succeeded' } : {};
T.request = { headers: { 'x-cron-secret': 'c' }, body: {} };`);
}
const charges = (r) => r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents'));

test('TED-143: after the camp\'s end date the nightly run charges nobody', () => {
    const r = nightly({ campDates: { startDate: '2026-06-20', endDate: yesterday } });
    assert.strictEqual(charges(r).length, 0, 'a parent was charged after the season');
    assert.ok(r.body.details.some(d => d.result === 'skipped_season_over'), JSON.stringify(r.body));
});

test('TED-143: the office\'s switch (Snacks → Settings) stops every auto-reload at the camp', () => {
    const r = nightly({ campDates: { endDate: nextMonth }, snacksSettings: { autoReloadOff: true } });
    assert.strictEqual(charges(r).length, 0);
    assert.ok(r.body.details.some(d => d.result === 'skipped_switched_off_by_camp'), JSON.stringify(r.body));
});

test('TED-143: during the season (or with no dates set) it still tops up as before', () => {
    assert.strictEqual(charges(nightly({ campDates: { endDate: nextMonth } })).length, 1);
    assert.strictEqual(charges(nightly({ campDates: { endDate: today } })).length, 1, 'the last day is still camp');
    assert.strictEqual(charges(nightly({})).length, 1);
});

// ── a refund that empties the wallet switches that child's auto-reload off ──

function refundAll(extra) {
    return `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
T.tables.refund_intents = [];
T.rpc.claim_refund_intent = () => ({ claimed: true });
T.rpc.settle_refund_intent = () => true;
T.rpc.release_refund_intent = () => true;
const tx: any[] = [{ kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top1', amount: 20, camper: 'Avi', camperId: 7, timestamp: 1 }];
let bal = 20;
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0,
  autoReload: { enabled: true, cardOnFile: true, stripeCustomerId: 'cus_P', thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20 } } },
  transactions: JSON.parse(JSON.stringify(tx)) });
${HOLDS}
T.tables.__paused = [];
T.rpc.update_canteen_autoreload_state = (a: any) => { T.tables.__paused.push(a); return { success: true }; };
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_intents/')) return { id: 'pi_top1', transfer_data: null };
  if (init.method === 'POST' && url.endsWith('/refunds')) return { id: 're_1', status: 'succeeded', amount: 2000, created: Math.floor(Date.now() / 1000) };
  return { data: [], has_more: false };
};
${extra}`;
}

test('TED-143: Refund All switches off the auto-reload of each child it refunds — the parent is told why in Link', () => {
    const r = runEdge('stripe-canteen-refund-all', refundAll(`T.request = { headers: { Authorization: 'Bearer owner' }, body: {} };`));
    assert.strictEqual(r.body.totalRefunded, 20, JSON.stringify(r.body));
    const p = r.tables.__paused;
    assert.strictEqual(p.length, 1, 'auto-reload was left on for a child whose wallet was just emptied');
    assert.strictEqual(p[0].p_camper_id, 7);
    assert.strictEqual(p[0].p_autoreload.enabled, false);
    assert.match(p[0].p_autoreload.disabledReason, /refunded the canteen balance/);
    assert.strictEqual(p[0].p_autoreload.stripeCustomerId, 'cus_P', 'the rest of the parent\'s set-up was lost');
});

test('TED-143: a child\'s own Refund that empties the wallet does the same; a partial one does not', () => {
    const all = runEdge('stripe-canteen-refund', refundAll(`T.request = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', idempotencyKey: 'k1' } };`));
    assert.strictEqual(all.body.totalRefunded, 20, JSON.stringify(all.body));
    assert.strictEqual(all.tables.__paused.length, 1);
    const part = runEdge('stripe-canteen-refund', refundAll(`T.request = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 5, idempotencyKey: 'k2' } };`)
        .replace("return { id: 're_1', status: 'succeeded', amount: 2000,", "return { id: 're_1', status: 'succeeded', amount: 500,"));
    assert.strictEqual(part.body.totalRefunded, 5, JSON.stringify(part.body));
    assert.strictEqual(part.tables.__paused.length, 0, 'a $5 refund switched auto-reload off');
});
