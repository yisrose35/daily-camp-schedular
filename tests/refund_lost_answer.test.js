// =============================================================================
// refund_lost_answer.test.js — TED-093, the real refund functions.
//
// The office refunds $100. The card company does it, and the connection drops
// before it answers. Before: "Refund failed", the office clicked again, and the
// family got $200 back. Now the claim is kept; a retry is told to check the
// processor and sends nothing; only an explicit "nothing went through" sends it.
// On Stripe the retry re-asks with the SAME key, so Stripe answers with the
// refund it already made.
// =============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');
const { HOLDS } = require('./canteen_wallet_model');

// migration 198's claim, as a model (pgtests cover the SQL)
const CLAIMS = `
const claims: Record<string, any> = {};
T.rpc.claim_refund_intent = (a: any) => { const c = claims[a.p_key]; if (c) return { claimed: false, previous: c.result || {} }; claims[a.p_key] = {}; return { claimed: true }; };
T.rpc.release_refund_intent = (a: any) => { if (claims[a.p_key] && !claims[a.p_key].result) delete claims[a.p_key]; return true; };
T.rpc.settle_refund_intent = (a: any) => { claims[a.p_key] = { result: a.p_result }; return true; };
// 273: only a claim that has waited a few minutes can be released; T.aged says it has
T.rpc.release_stale_refund_intent = (a: any) => { const c = claims[a.p_key]; if (c && !c.result && T.aged) { delete claims[a.p_key]; return true; } return false; };
T.rpc.record_processor_transaction = () => ({ success: true });
T.rpc.record_external_refund = () => ({ success: true });`;

const BYOP = (extra) => `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
${CLAIMS}
let n = 0;
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) {
    if (n++ === 0) throw new Error('connection reset');   // the gateway refunded; its answer is lost
    return 'xResult=A&xRefNum=R' + n + '&xStatus=Approved';
  }
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { externalTransactionId: 'X100', amount: 100, idempotencyKey: 'rfnd_gold:pay_1:50000:10000' } };
${extra}`;
const gatewayRefunds = r => r.fetches.filter(f => String(f.body || '').includes('cc%3Arefund')).length;

test('TED-093: a Cardknox refund whose answer was lost is not sent again on a retry', () => {
    const r = runEdge('payments-refund', BYOP(`T.requests = [req, req];`));
    const [a, b] = r.responses.map(x => x.body);
    assert.strictEqual(a.uncertain, true, 'the first try must say it may have gone through: ' + JSON.stringify(a));
    assert.strictEqual(b.uncertain, true, 'the retry must not look like a success or send again: ' + JSON.stringify(b));
    assert.ok(!b.replayed, 'an unconfirmed refund was replayed as a success');
    assert.strictEqual(gatewayRefunds(r), 1, 'the family was refunded twice');
});

test('TED-093: the office confirms nothing went through, and it is sent — once', () => {
    const r = runEdge('payments-refund', BYOP(`
      const sure = { headers: req.headers, body: Object.assign({}, req.body, { confirmNotRefunded: true }) };
      T.aged = true;
      T.requests = [req, sure, req];`));
    const [, b, c] = r.responses.map(x => x.body);
    assert.strictEqual(b.externalTransactionId, 'R2', JSON.stringify(b));
    assert.strictEqual(c.replayed, true, 'after it settled, a retry replays it');
    assert.strictEqual(gatewayRefunds(r), 2);
});

test('TED-094: a negative refund amount is refused before anything is sent', () => {
    const r = runEdge('payments-refund', BYOP(`T.requests = [{ headers: req.headers, body: Object.assign({}, req.body, { amount: -50 }) }];`));
    assert.strictEqual(r.status, 400);
    assert.strictEqual(gatewayRefunds(r), 0);
});

test('TED-093: a Stripe refund whose answer was lost is re-asked with the SAME key', () => {
    const r = runEdge('stripe-refund', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'stripe', stripe_account_id: 'acct_1' }];
${CLAIMS}
let n = 0;
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) { if (n++ === 0) throw new Error('connection reset'); return { id: 're_1', status: 'succeeded', amount: 10000 }; }
  if (url.includes('/payment_intents/')) return { id: 'pi_1', amount: 50000, latest_charge: 'ch_1', transfer_data: null, metadata: { campId: 'camp1' } };
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { paymentIntentId: 'pi_1', amount: 100, idempotencyKey: 'rfnd_gold:pay_1:50000:10000' } };
T.requests = [req, req];`);
    const posts = r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/refunds'));
    assert.strictEqual(posts.length, 2, JSON.stringify(r.responses));
    assert.strictEqual(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key'],
        'a retry used a new key — Stripe would refund twice');
    assert.strictEqual(r.responses[1].body.refundId, 're_1', JSON.stringify(r.responses[1].body));
});

// ── TED-096: a card deposit made on the form's own Stripe customer ─────────
const DEP = (famCustomer, metaCamp) => `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'stripe', stripe_account_id: 'acct_1' }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', stripeCustomerId: ${famCustomer ? `'${famCustomer}'` : 'null'} } });
${CLAIMS}
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) return { id: 're_dep', status: 'succeeded', amount: 25000 };
  if (url.includes('/payment_intents/')) return { id: 'pi_dep', amount: 25000, customer: 'cus_form', latest_charge: 'ch_1',
      metadata: { source: 'registration_deposit', campId: '${metaCamp}' } };
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: { paymentIntentId: 'pi_dep', amount: 250, idempotencyKey: 'rfnd_gold:dep_pi_dep:25000:25000' } };`;
const refundsSent = r => r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/refunds')).length;

test('TED-096: a card deposit is refundable when the family is on a different card, or none', () => {
    for (const fam of ['cus_office', null]) {
        const r = runEdge('stripe-refund', DEP(fam, 'camp1'));
        assert.strictEqual(r.body.refundId, 're_dep', (fam || 'no card') + ': ' + JSON.stringify(r.body));
        assert.strictEqual(refundsSent(r), 1);
    }
});

test('TED-096: another camp\'s payment is still refused', () => {
    const r = runEdge('stripe-refund', DEP('cus_form', 'camp2'));
    assert.strictEqual(r.status, 403);
    assert.strictEqual(refundsSent(r), 0);
});

test('TED-093: "nothing went through" seconds after the first click (a double-click) sends nothing', () => {
    const r = runEdge('payments-refund', BYOP(`
      const sure = { headers: req.headers, body: Object.assign({}, req.body, { confirmNotRefunded: true }) };
      T.aged = false;
      T.requests = [req, sure];`));
    assert.strictEqual(r.responses[1].body.uncertain, true, JSON.stringify(r.responses[1].body));
    assert.match(r.responses[1].body.error, /moment ago/);
    assert.strictEqual(gatewayRefunds(r), 1);
});

// ── "Refund everyone" in Snacks sends an empty body ─────────────────────────
test('TED-093: Refund everyone, a lost answer, then Try Again — the child is refunded once', () => {
    const r = runEdge('payments-canteen-refund-all', `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
const tx: any[] = [{ kind: 'deposit', method: 'cardknox', byopTransactionId: 'D1', amount: 50, camper: 'Avi', camperId: 7, timestamp: 1 }];
let bal = 50;
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: tx });
${CLAIMS}
${HOLDS}
let n = 0;
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) {
    if (n++ === 0) throw new Error('connection reset');
    return 'xResult=A&xRefNum=R' + n + '&xStatus=Approved';
  }
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: {} };
T.requests = [req, req];`);
    assert.strictEqual(gatewayRefunds(r), 1, 'the child was refunded twice: ' + JSON.stringify(r.responses.map(x => x.body)).slice(0, 400));
});

// ── TED-097: two same-amount Stripe canteen refunds on one day ─────────────
test('TED-097: a second $20 Stripe canteen refund later the same day is a new refund', () => {
    const r = runEdge('stripe-canteen-refund', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
const tx: any[] = [{ kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top', amount: 50, camper: 'Avi', camperId: 7, timestamp: 1 }];
let bal = 50;
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: tx });
T.rpc.refund_canteen_deposit_from_stripe = (a: any) => {
  if (tx.some(t => t.stripeRefundId === a.p_refund_id)) return { success: true, alreadyProcessed: true };
  tx.push({ kind: 'refund', stripePaymentIntentId: a.p_payment_intent_id, amount: a.p_amount, stripeRefundId: a.p_refund_id, camperId: 7 });
  bal -= a.p_amount; return { success: true, balance: bal };
};
${HOLDS}
const seen: Record<string, any> = {}; let n = 0;       // Stripe: same key within 24 h = the first answer
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = init.headers['Idempotency-Key'];
    if (!seen[k]) { n++; seen[k] = { id: 're_' + n, status: 'succeeded', amount: Number(new URLSearchParams(init.body).get('amount')) }; }
    return seen[k];
  }
  if (url.includes('/payment_intents/')) return { id: 'pi_top', transfer_data: null };
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20 } };
T.requests = [req, req];`);
    const keys = r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/refunds')).map(f => f.headers['Idempotency-Key']);
    assert.strictEqual(keys.length, 2);
    assert.notStrictEqual(keys[0], keys[1], 'Stripe answered the second refund with the first');
    assert.deepStrictEqual(r.responses.map(x => x.body.refunds && x.body.refunds[0].refundId), ['re_1', 're_2']);
});

// ── TED-100: Campistry's own SMS fees are never the camp's to refund ───────
test('TED-100: a camp cannot refund Campistry\'s SMS number or monthly fee to itself', () => {
    for (const purpose of ['telnyx_monthly_fee', 'telnyx_number_registration']) {
        for (const customer of ['cus_camp_itself', null]) {
            const r = runEdge('stripe-refund', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'stripe', stripe_account_id: 'acct_1' }];
T.rpc.camp_families_object = () => ({ gold: { name: 'Gold', stripeCustomerId: 'cus_family' } });
${CLAIMS}
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) return { id: 're_fee', status: 'succeeded', amount: 2500 };
  if (url.includes('/payment_intents/')) return { id: 'pi_fee', amount: 2500, customer: ${customer ? `'${customer}'` : 'null'},
      metadata: { campId: 'camp1', purpose: '${purpose}' } };
  return {};
};
T.request = { headers: { Authorization: 'Bearer owner' }, body: { paymentIntentId: 'pi_fee', amount: 25, idempotencyKey: 'k1' } };`);
            assert.strictEqual(r.status, 403, purpose + '/' + customer + ': ' + JSON.stringify(r.body));
            assert.strictEqual(r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/refunds')).length, 0);
        }
    }
});

// ── TED-105: the same single canteen refund, retried after a lost answer ───
test('TED-105: Stripe canteen refund — the retry of one refund (same page key) is not a second refund', () => {
    const r = runEdge('stripe-canteen-refund', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
const tx: any[] = [{ kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top', amount: 50, camper: 'Avi', camperId: 7, timestamp: 1 }];
let bal = 50;
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: tx });
T.rpc.refund_canteen_deposit_from_stripe = (a: any) => {
  if (tx.some(t => t.stripeRefundId === a.p_refund_id)) return { success: true, alreadyProcessed: true };
  tx.push({ kind: 'refund', stripePaymentIntentId: a.p_payment_intent_id, amount: a.p_amount, stripeRefundId: a.p_refund_id, camperId: 7 });
  bal -= a.p_amount; return { success: true, balance: bal };
};
${HOLDS}
const seen: Record<string, any> = {}; let n = 0;
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = init.headers['Idempotency-Key'];
    if (!seen[k]) { n++; seen[k] = { id: 're_' + n, status: 'succeeded', amount: Number(new URLSearchParams(init.body).get('amount')) }; }
    return seen[k];
  }
  if (url.includes('/payment_intents/')) return { id: 'pi_top', transfer_data: null };
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_1' } };
T.requests = [req, req];`);
    const ids = r.responses.map(x => x.body.refunds && x.body.refunds[0] && x.body.refunds[0].refundId);
    assert.deepStrictEqual(ids, ['re_1', 're_1'], 'the retry made a second refund: ' + JSON.stringify(ids));
});

test('TED-105: Snacks keeps one key per refund while it is retried, and starts a new one after success', () => {
    const SN = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'campistry_snacks.js'), 'utf8');
    assert.match(SN, /if \(!window\._canteenRefundKey \|\| window\._canteenRefundKey\.sig !== _sig\)/);
    assert.match(SN, /idempotencyKey: window\._canteenRefundKey\.key/);
    assert.match(SN, /window\._canteenRefundKey = null;/);
});

// ── TED-105 (7th pass): the same canteen refund retried, when the child topped
// up more than once. The claim model keeps T.tables.refund_intents in step, as
// the real table would be, since the functions read earlier parts from it.
const CLAIM_TABLE = `
T.tables.refund_intents = [];
const row = (k: string) => T.tables.refund_intents.find((x: any) => x.key === k);
T.rpc.claim_refund_intent = (a: any) => { const c = row(a.p_key); if (c) return { claimed: false, previous: c.result || {} };
  T.tables.refund_intents.push({ camp_id: a.p_camp_id, key: a.p_key, amount: a.p_amount, result: null, settled_at: null }); return { claimed: true }; };
T.rpc.settle_refund_intent = (a: any) => { const c = row(a.p_key); if (c) { c.result = a.p_result; c.settled_at = 'now'; } return true; };
T.rpc.release_refund_intent = (a: any) => { T.tables.refund_intents = T.tables.refund_intents.filter((x: any) => !(x.key === a.p_key && !x.settled_at)); return true; };
T.rpc.release_stale_refund_intent = () => false;
T.rpc.record_processor_transaction = () => ({ success: true });`;

const stripeTopups = (deps) => `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner' }];
${CLAIM_TABLE}
const tx: any[] = ${JSON.stringify(deps.map((a, i) => ({ kind: 'deposit', method: 'stripe', stripePaymentIntentId: 'pi_top' + (i + 1), amount: a, camper: 'Avi', camperId: 7, timestamp: i + 1 })))};
let bal = ${deps.reduce((s, a) => s + a, 0)};
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: tx });
T.rpc.refund_canteen_deposit_from_stripe = (a: any) => {
  if (tx.some(t => t.stripeRefundId === a.p_refund_id)) return { success: true, alreadyProcessed: true };
  tx.push({ kind: 'refund', stripePaymentIntentId: a.p_payment_intent_id, amount: a.p_amount, stripeRefundId: a.p_refund_id, camperId: 7 });
  bal -= a.p_amount; return { success: true, balance: bal };
};
${HOLDS}
const seen: Record<string, any> = {}; let n = 0;
T.fetch = (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = init.headers['Idempotency-Key'];
    if (!seen[k]) { n++; seen[k] = { id: 're_' + n, status: 'succeeded', amount: Number(new URLSearchParams(init.body).get('amount')) }; }
    return seen[k];
  }
  if (url.includes('/payment_intents/')) return { id: 'pi', transfer_data: null };
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_1' } };
T.requests = [req, req];`;

const byopTopups = (deps) => `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
${CLAIM_TABLE}
const tx: any[] = ${JSON.stringify(deps.map((a, i) => ({ kind: 'deposit', method: 'cardknox', byopTransactionId: 'X' + (i + 1), amount: a, camper: 'Avi', camperId: 7, timestamp: i + 1 })))};
let bal = ${deps.reduce((s, a) => s + a, 0)};
T.rpc.canteen_refund_view = () => ({ success: true, accounts: { Avi: { camperId: 7, balance: bal, balanceFloor: 0 } }, transactions: tx });
T.rpc.refund_canteen_deposit_from_processor = (a: any) => {
  tx.push({ kind: 'refund', byopTransactionId: a.p_external_transaction_id, amount: a.p_amount, camperId: 7 });
  bal -= a.p_amount; return { success: true, balance: bal };
};
${HOLDS}
let n = 0;
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) { n++; return 'xResult=A&xRefNum=R' + n + '&xStatus=Approved'; }
  return {};
};
const req = { headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_1' } };
T.requests = [req, req];`;

for (const [name, deps] of Object.entries({ 'one top-up': [50], 'two top-ups': [50, 50], 'the $20 spans two': [10, 50] })) {
    test(`TED-105: Stripe canteen refund retried with the same key (${name}) — one $20 refund`, () => {
        const r = runEdge('stripe-canteen-refund', stripeTopups(deps));
        const made = new Set(r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/refunds')).map(f => f.headers['Idempotency-Key']));
        const cents = [...new Set(r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/refunds')).map(f => f.headers['Idempotency-Key'] + '=' + new URLSearchParams(f.body).get('amount')))]
            .reduce((t, x) => t + Number(x.split('=')[1]), 0);
        assert.strictEqual(cents, 2000, name + ': refunded ' + cents / 100 + ' across ' + JSON.stringify([...made]));
        assert.strictEqual(r.responses[1].body.totalRefunded, 20, JSON.stringify(r.responses[1].body));
    });
    test(`TED-105: Cardknox canteen refund retried with the same key (${name}) — one $20 refund, reported as done`, () => {
        const r = runEdge('payments-canteen-refund', byopTopups(deps));
        const sent = r.fetches.filter(f => String(f.body || '').includes('cc%3Arefund'))
            .reduce((t, f) => t + Number(new URLSearchParams(f.body).get('xAmount')), 0);
        assert.strictEqual(sent, 20, name + ': $' + sent + ' went back to the card');
        assert.strictEqual(r.responses[1].body.totalRefunded, 20, 'the retry said: ' + JSON.stringify(r.responses[1].body));
        assert.ok(!r.responses[1].body.error);
    });
}
