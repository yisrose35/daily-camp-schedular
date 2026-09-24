// =============================================================================
// office_charge_retry.test.js — TED-111. Me → Billing → a family → Charge Card.
//
// The office charges a family's saved card $500. The card company takes it and
// the answer never gets back. Before: "Charge failed", and pressing Charge Card
// again charged the parent another $500 (a new key every press; Banquest's
// gateway timeout was shown as "Declined"). Now the page keeps one key for the
// charge it means to make until it succeeds or is declined, the functions say
// "may have gone through" instead of "failed", and a second press charges
// nothing more. From Ted's 9th-pass probe (ted/probes/2026-09-24-billing-9/).
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runEdge } = require('./edge_harness');

const ME = fs.readFileSync(path.join(__dirname, '..', 'campistry_me.js'), 'utf8');
function cut(re) { const m = ME.match(re); assert.ok(m, 'not found: ' + re); return m[0]; }
const SRC = [
    cut(/async function chargeStoredCard\(famKey,amount,description,quiet\)\{[\s\S]*?\n\}\n/),
    cut(/function _pendingChargeStoreKey\(\)\{[^\n]*\n/),
    cut(/function _pendingChargeAll\(\)\{[^\n]*\n/),
    cut(/function _pendingChargeGet\(famKey,amount\)\{[\s\S]*?\n\}\n/),
    cut(/function _pendingChargeSet\(famKey,amount,v\)\{[\s\S]*?\n\}\n/),
    cut(/function _pendingChargeClear\(famKey,amount\)\{[\s\S]*?\n\}\n/),
].join('\n');

function page(answers) {
    const store = {}; const sent = []; const toasts = []; const posted = [];
    const ctx = {
        families: { gold: { name: 'Gold', stripeCustomerId: 'cus_G', stripePaymentMethodId: 'pm_G' } },
        finPayments: [], curPage: 'billing',
        toast: (t) => toasts.push(t), save: () => {}, renderBilling: () => {}, renderFamilyDetailPage: () => {},
        _postPaymentEntry: (f, row) => { posted.push(row.reference); return true; }, fm: (n) => '$' + n, esc: (s) => s,
        getCampId: () => 'camp1',
        localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
        window: { confirm: () => false },
        callEdgeFunctionAuthed: async (fn, body) => {
            sent.push(body.idempotencyKey);
            const a = answers.shift();
            if (a instanceof Error) throw a;
            if (a && a.error) { const e = new Error(a.error); e.data = a; throw e; }
            return a;
        },
    };
    const f = new Function(...Object.keys(ctx), SRC + '; return chargeStoredCard;')(...Object.values(ctx));
    return { charge: f, sent, toasts, posted };
}
const lost = () => Object.assign(new Error('Failed to send a request to the Edge Function'), { status: null, noAnswer: true });

test('TED-111: a lost answer is "may have gone through", and the next press sends the SAME key', async () => {
    const p = page([lost(), { paymentIntentId: 'pi_1', status: 'succeeded', amount: 500 }]);
    const r1 = await p.charge('gold', 500, 'Camp payment');
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.uncertain, true);
    assert.ok(!p.toasts.some(t => /^Charge failed/.test(t)), 'told "failed": ' + JSON.stringify(p.toasts));
    assert.ok(p.toasts.some(t => /may have gone through/.test(t)), JSON.stringify(p.toasts));
    const r2 = await p.charge('gold', 500, 'Camp payment');
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(p.sent[0], p.sent[1], 'the second press used a new key — a second charge');
    assert.deepStrictEqual(p.posted, ['pi_1']);
});

test('TED-111: after it went through, or was declined, the next charge is a new one', async () => {
    const p = page([{ paymentIntentId: 'pi_1', status: 'succeeded' }, { paymentIntentId: 'pi_2', status: 'succeeded' },
                    { declined: true, error: 'Your card was declined.' }, { paymentIntentId: 'pi_3', status: 'succeeded' }]);
    await p.charge('gold', 500, 'Camp payment');
    await p.charge('gold', 500, 'Camp payment');          // a second, deliberate $500
    const r = await p.charge('gold', 500, 'Camp payment');
    assert.strictEqual(r.error, 'Your card was declined.');
    assert.strictEqual(r.uncertain, false);
    assert.ok(p.toasts.some(t => t === 'Charge failed: Your card was declined.'), JSON.stringify(p.toasts));
    await p.charge('gold', 500, 'Camp payment');          // the parent fixed the card
    assert.strictEqual(new Set(p.sent).size, 4, 'keys: ' + JSON.stringify(p.sent));
});

test('TED-111: a different amount is a different charge', async () => {
    const p = page([lost(), { paymentIntentId: 'pi_9', status: 'succeeded' }]);
    await p.charge('gold', 500, 'Camp payment');
    await p.charge('gold', 250, 'Camp payment');
    assert.notStrictEqual(p.sent[0], p.sent[1]);
});

// ── the real functions ─────────────────────────────────────────────────────
test('TED-111: stripe-charge — Stripe charged, the answer was lost; pressed again: one charge', () => {
    const r = runEdge('stripe-charge', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', name: 'Camp One', stripe_account_id: 'acct_CAMP', stripe_charges_enabled: true }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', stripeCustomerId: 'cus_G' } });
const made: Record<string, any> = {}; let n = 0, posts = 0; T.tables.__charged = [];
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_methods/')) return { id: 'pm_G', customer: 'cus_G' };
  if (init.method === 'POST' && url.endsWith('/payment_intents')) {
    posts++;
    const k = init.headers['Idempotency-Key'];
    if (!made[k]) { n++; made[k] = { id: 'pi_' + n, status: 'succeeded' }; T.tables.__charged.push(Number(new URLSearchParams(init.body).get('amount'))); }
    if (posts === 1) throw new Error('connection reset');
    return made[k];
  }
  return {};
};
const press = { headers: { Authorization: 'Bearer owner' }, body: { customerId: 'cus_G', paymentMethodId: 'pm_G', amount: 500, metadata: { familyKey: 'gold' }, idempotencyKey: 'chg_gold_1' } };
T.requests = [press, press];`);
    assert.strictEqual(r.responses[0].status, 200);
    assert.strictEqual(r.responses[0].body.uncertain, true, JSON.stringify(r.responses[0].body));
    assert.strictEqual(r.responses[1].body.paymentIntentId, 'pi_1');
    assert.deepStrictEqual(r.tables.__charged, [50000]);
});

test('TED-111: stripe-charge — a card decline is a definite "declined", not a 500', () => {
    const r = runEdge('stripe-charge', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', name: 'Camp One' }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', stripeCustomerId: 'cus_G' } });
T.fetch = (url: string, init: any) => {
  if (url.includes('/payment_methods/')) return { id: 'pm_G', customer: 'cus_G' };
  if (init.method === 'POST' && url.endsWith('/payment_intents')) return { __status: 402, error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } };
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: { customerId: 'cus_G', paymentMethodId: 'pm_G', amount: 500, idempotencyKey: 'chg_gold_1' } };`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { declined: true, error: 'Your card was declined.' });
});

const BYOP = (proc, fetchModel, extra) => `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: '${proc}' }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', byopCustomerRef: '123' } });
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck', sourceKey: 's', pin: 'p' } });
T.tables.refund_intents = [];
const row = (k: string) => T.tables.refund_intents.find((r: any) => r.key === k);
T.rpc.claim_refund_intent = (a: any) => { const c = row(a.p_key); if (c) return { claimed: false, previous: c.result || {} }; T.tables.refund_intents.push({ key: a.p_key, result: null }); return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { const c = row(a.p_key); if (c) c.result = a.p_result; return true; };
T.rpc.release_refund_intent = (a: any) => { T.tables.refund_intents = T.tables.refund_intents.filter((r: any) => r.key !== a.p_key || r.result); return true; };
T.rpc.release_stale_refund_intent = (a: any) => { const c = row(a.p_key); if (c && !c.result && T.aged) { T.tables.refund_intents = T.tables.refund_intents.filter((r: any) => r !== c); return true; } return false; };
T.rpc.record_processor_transaction = () => ({ success: true });
let n = 0; T.tables.__charged = [];
${fetchModel}
const press = { headers: { Authorization: 'Bearer owner' }, body: { customerRef: '123', amount: 500, familyKey: 'gold', idempotencyKey: 'chg_gold_1' } };
${extra}`;

test('TED-111: payments-charge (Cardknox) — the answer was lost; pressed again: no second sale until the office confirms', () => {
    const r = runEdge('payments-charge', BYOP('cardknox', `
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Asale')) {
    n++; T.tables.__charged.push(n);
    if (n === 1) throw new Error('connection reset');
    return 'xResult=A&xRefNum=' + (9000 + n) + '&xStatus=Approved';
  }
  return {};
};`, `
const sure = { headers: press.headers, body: Object.assign({}, press.body, { confirmNotCharged: true }) };
T.aged = true;
T.requests = [press, press, sure, press];`));
    const [a, b, c, d] = r.responses.map(x => x.body);
    assert.strictEqual(a.uncertain, true, 'press 1: ' + JSON.stringify(a));
    assert.strictEqual(b.uncertain, true, 'press 2 must not charge or look paid: ' + JSON.stringify(b));
    assert.strictEqual(b.canConfirm, true);
    assert.ok(!b.externalTransactionId, 'an unconfirmed charge was reported as paid');
    assert.strictEqual(c.externalTransactionId, '9002', 'confirmed nothing went through: charged once more: ' + JSON.stringify(c));
    assert.strictEqual(d.replayed, true);
    assert.deepStrictEqual(r.tables.__charged, [1, 2], 'sales made');
});

test('TED-111: payments-charge — "nothing went through" seconds after the first try charges nothing', () => {
    const r = runEdge('payments-charge', BYOP('cardknox', `
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Asale')) { n++; T.tables.__charged.push(n); throw new Error('connection reset'); }
  return {};
};`, `
const sure = { headers: press.headers, body: Object.assign({}, press.body, { confirmNotCharged: true }) };
T.aged = false;
T.requests = [press, sure];`));
    assert.strictEqual(r.responses[1].body.uncertain, true);
    assert.match(r.responses[1].body.error, /moment ago/);
    assert.deepStrictEqual(r.tables.__charged, [1]);
});

test('TED-111: payments-charge (Banquest) — a gateway timeout is "may have gone through", and the claim is kept', () => {
    const r = runEdge('payments-charge', BYOP('banquest', `
T.fetch = (url: string) => url.endsWith('/transactions/charge') ? { __status: 504 } : {};`, `T.request = press;`));
    assert.strictEqual(r.body.uncertain, true, JSON.stringify(r.body));
    assert.ok(!/^Declined/.test(r.body.error), r.body.error);
    assert.strictEqual(r.tables.refund_intents.length, 1, 'the claim was released — a second press would charge again');
});

test('TED-111: payments-charge — a real decline releases the claim and says declined', () => {
    const r = runEdge('payments-charge', BYOP('cardknox', `
T.fetch = (url: string, init: any) => String(init.body || '').includes('cc%3Asale') ? 'xResult=D&xStatus=Declined&xError=Insufficient funds' : {};`, `T.request = press;`));
    assert.deepStrictEqual({ declined: r.body.declined, error: r.body.error }, { declined: true, error: 'Insufficient funds' });
    assert.strictEqual(r.tables.refund_intents.length, 0);
});
