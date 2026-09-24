// =============================================================================
// stripe_webhooks_fail_closed.test.js — TED-057. The real stripe-webhook and
// stripe-connect-webhook, run against a pretend database (edge_harness.js).
//
//   - with no signing secret set, every message is refused (it used to be
//     accepted unchecked, so a fake "payment succeeded" marked a family paid);
//   - a correctly signed, fresh message is accepted;
//   - a correctly signed message older than 5 minutes is refused (replay);
//   - a message with a wrong signature is refused.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');

// A "payment succeeded" for camp1, and a helper that signs it like Stripe.
const EVENT = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_fake', amount: 99900, metadata: { campId: 'camp1', familyKey: 'fam1' } } } });

function scenario(secretEnv, sign) {
    return `
const { createHmac } = await import('node:crypto');
T.env = Object.assign({ SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_SECRET_KEY: 'sk_test' }, ${JSON.stringify(secretEnv)});
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { families: {} } }];
const body = ${JSON.stringify(EVENT)};
const sign = ${sign ? `(secret: string, ageSeconds: number) => { const t = Math.floor(Date.now() / 1000) - ageSeconds; return 't=' + t + ',v1=' + createHmac('sha256', secret).update(t + '.' + body).digest('hex'); }` : 'null'};
T.request = { rawBody: body, headers: { 'stripe-signature': ${sign ? `sign(${JSON.stringify(sign.secret)}, ${sign.age})` : `'t=1,v1=bad'`} } };
`;
}

// Did the function act on the event at all? Any database write or rpc is action.
const acted = r => r.rpcs.length > 0 || r.writes.some(w => w.op !== 'select');

test('TED-057: stripe-webhook with no secret set refuses a fake "payment succeeded"', () => {
    const r = runEdge('stripe-webhook', scenario({}, null));
    assert.strictEqual(r.status, 500);
    assert.ok(!acted(r), 'the unsigned event was acted on');
});

test('TED-057: stripe-webhook refuses a wrong signature', () => {
    const r = runEdge('stripe-webhook', scenario({ STRIPE_WEBHOOK_SECRET: 'whsec_real' }, { secret: 'whsec_wrong', age: 0 }));
    assert.strictEqual(r.status, 400);
    assert.ok(!acted(r));
});

test('TED-057: stripe-webhook refuses a correctly signed message from 10 minutes ago (replay)', () => {
    const r = runEdge('stripe-webhook', scenario({ STRIPE_WEBHOOK_SECRET: 'whsec_real' }, { secret: 'whsec_real', age: 600 }));
    assert.strictEqual(r.status, 400);
    assert.ok(!acted(r), 'a replayed event was acted on');
});

test('stripe-webhook accepts a correctly signed, fresh message', () => {
    const r = runEdge('stripe-webhook', scenario({ STRIPE_WEBHOOK_SECRET: 'whsec_real' }, { secret: 'whsec_real', age: 5 }));
    assert.notStrictEqual(r.status, 400);
    assert.notStrictEqual(r.status, 500);
    assert.ok(acted(r), 'a genuine event was ignored');
});

test('TED-057: stripe-connect-webhook with no secret set refuses everything', () => {
    const r = runEdge('stripe-connect-webhook', scenario({}, null));
    assert.strictEqual(r.status, 500);
    assert.ok(!acted(r));
});

test('stripe-connect-webhook refuses a wrong signature and accepts a right one', () => {
    const bad = runEdge('stripe-connect-webhook', scenario({ STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_c' }, { secret: 'nope', age: 0 }));
    assert.strictEqual(bad.status, 400);
    const good = runEdge('stripe-connect-webhook', scenario({ STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_c' }, { secret: 'whsec_c', age: 0 }));
    assert.notStrictEqual(good.status, 400);
    assert.notStrictEqual(good.status, 500);
});
