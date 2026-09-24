// =============================================================================
// autopay_confirm_stripe.test.js — TED-120 (what was left), the real
// stripe-charge.
//
// An autopay charge the card company never answered waits for the office
// (276). On Stripe, "it went through" is now checked with Stripe before it is
// recorded (279): on an autopay night many families pay the same $500, so a
// payment id pasted from the dashboard is easily another family's, or a typo.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');

const HOLD = { unconfirmed: true, processor: 'stripe', amount: 500, index: 0, planId: 'plan_g', dueDate: '2026-06-01', since: '2026-06-01' };
const JUNE_2 = Math.floor(Date.parse('2026-06-02T13:00:00Z') / 1000);

function confirm(pi, opts) {
    const o = opts || {};
    return runEdge('stripe-charge', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
T.rpc.camp_families_object = () => ({
  gold: { name: 'Gold', stripeCustomerId: 'cus_gold', plans: [{ id: 'plan_g', pendingCharge: ${JSON.stringify('hold' in o ? o.hold : HOLD)} }] },
  silver: { name: 'Silver', stripeCustomerId: 'cus_silver', plans: [] } });
T.rpc.resolve_unconfirmed_autopay_checked = (a: any) => (${JSON.stringify(o.dbAnswer || { success: true, recorded: true })});
const PIS: any = {
  pi_GOLD:    { id: 'pi_GOLD', status: 'succeeded', amount: 50000, amount_received: 50000, customer: 'cus_gold', created: ${JUNE_2},
                metadata: { campId: 'camp1', familyKey: 'gold', planId: 'plan_g', source: 'autopay' } },
  pi_SILVER:  { id: 'pi_SILVER', status: 'succeeded', amount: 50000, amount_received: 50000, customer: 'cus_silver', created: ${JUNE_2},
                metadata: { campId: 'camp1', familyKey: 'silver', source: 'autopay' } },
  pi_STAMPED: { id: 'pi_STAMPED', status: 'succeeded', amount: 50000, amount_received: 50000, customer: 'cus_gold', created: ${JUNE_2},
                metadata: { campId: 'camp1', familyKey: 'silver' } },
  pi_SMALL:   { id: 'pi_SMALL', status: 'succeeded', amount: 25000, amount_received: 25000, customer: 'cus_gold', created: ${JUNE_2}, metadata: {} },
  pi_PENDING: { id: 'pi_PENDING', status: 'processing', amount: 50000, customer: 'cus_gold', created: ${JUNE_2}, metadata: {} },
  pi_OLD:     { id: 'pi_OLD', status: 'succeeded', amount: 50000, amount_received: 50000, customer: 'cus_gold',
                created: ${Math.floor(Date.parse('2026-05-01T12:00:00Z') / 1000)}, metadata: {} },
};
T.fetch = (url: string) => {
  ${o.stripeDown ? "return { __status: 503, error: { type: 'api_error', message: 'down' } };" : ''}
  const m = url.match(/\\/payment_intents\\/([^/?]+)$/);
  if (m) return PIS[decodeURIComponent(m[1])] || { __status: 404, error: { type: 'invalid_request_error', message: 'No such payment_intent' } };
  return {};
};
T.request = { headers: { Authorization: 'Bearer ${o.who || 'owner'}' }, body: { action: 'confirmAutopay', familyKey: 'gold', planRef: 'plan_g', paymentIntentId: ${JSON.stringify(pi)} } };`);
}
const recorded = (r) => r.rpcs.filter(c => c.name === 'resolve_unconfirmed_autopay_checked');

test('TED-120: Gold\'s own payment — succeeded, Gold\'s card, $500, after autopay tried — is recorded', () => {
    const r = confirm('pi_GOLD');
    assert.deepStrictEqual(r.body, { success: true, recorded: true });
    assert.deepStrictEqual(recorded(r).map(c => c.args), [{ p_camp_id: 'camp1', p_family_key: 'gold', p_plan_ref: 'plan_g', p_reference: 'pi_GOLD' }]);
});

const refused = [
    ['Silver\'s $500 pasted for Gold', 'pi_SILVER', /another customer/],
    ['a payment stamped for another family', 'pi_STAMPED', /another family/],
    ['a typo', 'pi_TYPO123', /no payment pi_TYPO123/],
    ['a payment for another amount', 'pi_SMALL', /\$250\.00, not this instalment's \$500\.00/],
    ['a payment still processing', 'pi_PENDING', /has not gone through/],
    ['an earlier payment', 'pi_OLD', /before autopay tried/],
    ['a charge id', 'ch_3Nx', /starts with pi_/],
];
for (const [what, pi, why] of refused) {
    test(`TED-120: ${what} is refused, and nothing is recorded`, () => {
        const r = confirm(pi);
        assert.strictEqual(r.body.success, false, JSON.stringify(r.body));
        assert.match(r.body.error, why);
        assert.strictEqual(recorded(r).length, 0);
    });
}

test('TED-120: Stripe not answering records nothing', () => {
    const r = confirm('pi_GOLD', { stripeDown: true });
    assert.match(r.body.error, /did not answer/);
    assert.strictEqual(recorded(r).length, 0);
});

test('TED-120: the database refusing (booked for someone else) is passed on in words', () => {
    const r = confirm('pi_GOLD', { dbAnswer: { success: false, error: 'reference_is_another_payment' } });
    assert.match(r.body.error, /already booked for another family/);
});

test('TED-120: a charge already answered is not answered again', () => {
    const r = confirm('pi_GOLD', { hold: null });
    assert.match(r.body.error, /already answered/);
    assert.strictEqual(recorded(r).length, 0);
});

test('TED-120: someone who is not the camp\'s owner or an admin is refused before Stripe is asked', () => {
    const r = confirm('pi_GOLD', { who: 'stranger' });
    assert.strictEqual(r.status, 403);
    // said for what was asked — nothing is being charged (TED-134)
    assert.strictEqual(r.body.error, 'Only the camp owner or an admin can confirm a Stripe autopay payment.');
    assert.strictEqual(recorded(r).length, 0);
});

test('TED-134: Billing shows the function\'s own reason, not "Edge Function returned a non-2xx status code"', async () => {
    const fs = require('node:fs'), path = require('node:path');
    const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
    const at = ME.indexOf('async function callEdgeFunctionAuthed(');
    let i = ME.indexOf('{', at), d = 0;
    for (; i < ME.length; i++) { if (ME[i] === '{') d++; else if (ME[i] === '}' && --d === 0) break; }
    const src = ME.slice(at, i + 1);
    const make = (status, body) => {
        const window = { CampistryDB: { getClient: () => ({ functions: { invoke: async () => ({ data: null,
            error: { message: 'Edge Function returned a non-2xx status code',
                     context: new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }) } }) } }) } };
        return new Function('window', src + '; return callEdgeFunctionAuthed;')(window);
    };
    const err = async (fn) => { try { await fn('stripe-charge', {}); } catch (e) { return e; } return null; };
    const e1 = await err(make(403, { error: 'Only the camp owner or an admin can confirm a Stripe autopay payment.' }));
    assert.strictEqual(e1.message, 'Only the camp owner or an admin can confirm a Stripe autopay payment.');
    assert.strictEqual(e1.noAnswer, false);
    // a 5xx still counts as "no answer", whatever it says (TED-111)
    const e2 = await err(make(500, { error: 'Stripe did not answer' }));
    assert.strictEqual(e2.message, 'Stripe did not answer');
    assert.strictEqual(e2.noAnswer, true);
    assert.strictEqual(e2.data, undefined);
    // not JSON: the generic words, rather than nothing
    const e3 = await err(make(502, '<html>Bad gateway</html>'));
    assert.strictEqual(e3.message, 'Edge Function returned a non-2xx status code');
});
