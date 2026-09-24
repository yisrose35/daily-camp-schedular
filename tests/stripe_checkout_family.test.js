// =============================================================================
// stripe_checkout_family.test.js — TED-063. A parent's "Pay Now" in Link on a
// Stripe camp sent no family, so the payment was credited to nobody (the parent
// still saw the full balance) and settled in the platform's Stripe account
// instead of the camp's. The real stripe-checkout runs here.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runEdge } = require('./edge_harness');

const W = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { parentGold: 'u-gold' };
T.tables.camps = [{ id: 'camp1', name: 'Camp One', stripe_account_id: 'acct_CAMP', stripe_charges_enabled: true }];
T.rpc.camp_family = (a: any) => a.p_family_key === 'gold' || a.p_family_key === 'stone' ? { name: a.p_family_key } : null;
// run as the signed-in parent, get_my_balance answers with THEIR family
T.rpc.get_my_balance = (_a: any, token: string) => token === 'parentGold' ? { success: true, familyKey: 'gold', balance: 1000 } : { success: false };
T.fetch = (url: string) => url.endsWith('/checkout/sessions') ? { id: 'cs_1', url: 'https://checkout.stripe.com/x' } : {};
`;
function session(r) {
    const s = r.fetches.find(f => f.url.endsWith('/checkout/sessions'));
    return s ? new URLSearchParams(s.body) : null;
}

test('TED-063: a signed-in parent\'s Pay Now is credited to their own family and settles in the camp\'s account', () => {
    const r = runEdge('stripe-checkout', W + `T.request = { headers: { Authorization: 'Bearer parentGold' },
        body: { campId: 'camp1', familyName: 'Gold', email: 'p@x', amount: 500 } };`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const p = session(r);
    assert.strictEqual(p.get('payment_intent_data[metadata][familyKey]'), 'gold');
    assert.strictEqual(p.get('payment_intent_data[transfer_data][destination]'), 'acct_CAMP');
});

test('TED-063: a signed-in parent cannot credit another family, whatever the request says', () => {
    const r = runEdge('stripe-checkout', W + `T.request = { headers: { Authorization: 'Bearer parentGold' },
        body: { campId: 'camp1', familyKey: 'stone', amount: 500 } };`);
    assert.strictEqual(session(r).get('payment_intent_data[metadata][familyKey]'), 'gold');
});

test('the office\'s emailed pay link (no parent login) carries the family the office chose', () => {
    const r = runEdge('stripe-checkout', W + `T.request = { headers: { Authorization: 'Bearer anon' },
        body: { campId: 'camp1', familyKey: 'stone', amount: 500 } };`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const p = session(r);
    assert.strictEqual(p.get('payment_intent_data[metadata][familyKey]'), 'stone');
    assert.strictEqual(p.get('payment_intent_data[transfer_data][destination]'), 'acct_CAMP');
});

test('TED-063: a tuition payment no family can be credited with is refused before Stripe', () => {
    for (const body of [`{ campId: 'camp1', amount: 500 }`, `{ campId: 'camp1', familyKey: 'nobody', amount: 500 }`]) {
        const r = runEdge('stripe-checkout', W + `T.request = { headers: { Authorization: 'Bearer anon' }, body: ${body} };`);
        assert.strictEqual(r.status, 400, body);
        assert.strictEqual(session(r), null, 'a checkout was opened that credits nobody: ' + body);
    }
});

test('Link sends the parent\'s login and the family with a Stripe Pay Now', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'campistry_link_parent.html'), 'utf8');
    assert.match(html, /_lkCheckout\(\{campId:cid,familyKey:d\.familyKey\|\|'',/);
    const fn = html.slice(html.indexOf('async function _lkCheckout('), html.indexOf('async function _lkCallEdge('));
    assert.match(fn, /getSession\(\)/);
    assert.match(fn, /'Authorization':'Bearer '\+token/);
});
