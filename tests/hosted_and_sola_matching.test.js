// =============================================================================
// hosted_and_sola_matching.test.js — a payment is only ever credited to the
// family it belongs to.
//
//   TED-072  Banquest's return page (payments-hosted-complete) only accepts the
//            transaction for THIS link — never "the newest on the account".
//   TED-071  Sola/Cardknox notices (cardknox-webhook): a notice that names a
//            reference we do not have is not matched by amount; a transaction
//            Campistry already recorded is never matched to a checkout; an
//            ambiguous one is put in front of the office.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { runEdge } = require('./edge_harness');

// ── Banquest return ──────────────────────────────────────────────────────────
const HOSTED = (txns) => `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.tables.banquest_pending_links = [{ key: 'KEY_A', camp_id: 'camp1', purpose: 'pay_now', family_key: 'famA', amount: 100, status: 'pending' }];
T.tables.camp_state_kv = [{ camp_id: 'camp1', key: 'campistryMe', value: { families: { famA: { name: 'Family A' } } } }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { sourceKey: 's', pin: 'p' } });
T.fetch = (url: string) => url.includes('/transactions?') ? ${JSON.stringify(txns)} : {};
T.request = { body: { key: 'KEY_A' } };
`;
const credited = r => r.rpcs.find(x => /append_camp_payment|record_hosted|camp_payment_add|record_external_payment/.test(x.name)) || r.writes.find(w => w.op !== 'select' && w.table !== 'banquest_pending_links');

test('TED-072: another family\'s transaction on the account is never taken for this link', () => {
    const r = runEdge('payments-hosted-complete', HOSTED([{ transaction_details: { reference_number: 777, key: 'KEY_OTHER' }, status_details: { status: 'captured' }, amount_details: { amount: 350 } }]));
    assert.strictEqual(r.body.pending, true, JSON.stringify(r.body));
    assert.ok(!credited(r), 'a family was credited with another family\'s payment');
});

test('TED-072: an unlabelled transaction for a different amount is not taken either', () => {
    const r = runEdge('payments-hosted-complete', HOSTED([{ transaction_details: { reference_number: 778 }, status_details: { status: 'captured' }, amount_details: { amount: 350 } }]));
    assert.strictEqual(r.body.pending, true);
});

test('this link\'s own transaction is recorded', () => {
    const r = runEdge('payments-hosted-complete', HOSTED([
        { transaction_details: { reference_number: 777, key: 'KEY_OTHER' }, status_details: { status: 'captured' }, amount_details: { amount: 350 } },
        { transaction_details: { reference_number: 779, key: 'KEY_A' }, status_details: { status: 'captured' }, amount_details: { amount: 100 } }]));
    assert.notStrictEqual(r.body.pending, true, JSON.stringify(r.body));
    assert.strictEqual(r.body.success, true, JSON.stringify(r.body));
});

// ── Sola / Cardknox ──────────────────────────────────────────────────────────
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
function signed(fields) {
    const body = new URLSearchParams(fields).toString();
    const pairs = [...new URLSearchParams(body).entries()].map(([k, v]) => [k.toLowerCase(), v]).sort((a, b) => a[0] < b[0] ? -1 : 1);
    return { body, sig: md5(pairs.map(p => p[1]).join('') + 'PIN') };
}
const recent = new Date().toISOString();
const dep = (ref, enr) => ({ reference: ref, camp_id: 'camp1', kind: 'registration_deposit', status: 'pending', amount_cents: 25000, enrollment_id: enr, created_at: recent, family_key: null });
const SOLA = (intents, known) => `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.rpc._admin_get_processor_credential = () => ({ success: true, processorKey: 'cardknox', credentials: { apiKey: 'k', webhookPin: 'PIN' } });
T.rpc.get_cardknox_checkout_intent = () => ({ success: false });
T.tables.cardknox_checkout_intents = ${JSON.stringify(intents)};
T.tables.processor_transactions = ${JSON.stringify(known || [])};
T.tables.notifications = [];
T.rpc._record_registration_deposit = (a: any) => ({ success: true });
`;
function post(fields) {
    const { body, sig } = signed(fields);
    return `T.request = { url: 'http://edge.test/fn?campId=camp1', headers: { 'ck-signature': '${sig}', 'content-type': 'application/x-www-form-urlencoded' }, rawBody: '${body}' };`;
}
const depositCredited = r => r.rpcs.some(x => x.name === '_record_registration_deposit');

test('the normal case still works: Sola sends no reference, one checkout at that amount -> credited', () => {
    const r = runEdge('cardknox-webhook', SOLA([dep('ckrd_A', 'enr_A')]) + post({ xAmount: '250.00', xRefNum: '9000', xResponseResult: 'Approved' }));
    assert.ok(depositCredited(r), 'the one matching checkout was not credited');
});

test('TED-071: a notice naming a reference we do not have is not matched by amount', () => {
    const r = runEdge('cardknox-webhook', SOLA([dep('ckrd_A', 'enr_A')]) + post({ xAmount: '250.00', xRefNum: '9002', xResponseResult: 'Approved', xInvoice: 'CI-lz9abc' }));
    assert.ok(!depositCredited(r), 'an office charge was credited as a family\'s deposit');
});

test('TED-071: a transaction Campistry already recorded is never matched to a checkout', () => {
    const r = runEdge('cardknox-webhook', SOLA([dep('ckrd_A', 'enr_A')], [{ id: 'x', processor_key: 'cardknox', external_transaction_id: '9003' }])
        + post({ xAmount: '250.00', xRefNum: '9003', xResponseResult: 'Approved' }));
    assert.ok(!depositCredited(r), 'the office\'s own charge was credited as a deposit');
});

test('TED-071: two checkouts at one amount — nothing is guessed, and the office is told', () => {
    const r = runEdge('cardknox-webhook', SOLA([dep('ckrd_A', 'enr_A'), dep('ckrd_B', 'enr_B')]) + post({ xAmount: '250.00', xRefNum: '9001', xResponseResult: 'Approved' }));
    assert.ok(!depositCredited(r));
    const n = r.writes.find(w => w.table === 'notifications' && w.op === 'upsert');
    assert.ok(n, 'the office was not told about the payment it has to match by hand');
    assert.match(n.payload.body, /250\.00/);
});
