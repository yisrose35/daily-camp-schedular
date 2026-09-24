// =============================================================================
// canteen_autoreload_once.test.js — TED-075. Two top-up checks for the same
// child at the same moment (two quick sales at the register) both read the same
// low balance and both charged the parent's card. The real canteen-auto-reload
// runs twice concurrently here.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runEdge } = require('./edge_harness');

const TWICE = (piAnswer) => `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'c' };
T.users = { pos: 'u-counselor' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: null }];
T.tables.camp_users = [{ camp_id: 'camp1', user_id: 'u-counselor' }];
let state: any = { enabled: true, cardOnFile: true, stripeCustomerId: 'cus_P', thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 50 };
T.rpc.canteen_autoreload_accounts = () => [{ camp_id: 'camp1', resolvable: true, person_id: 7, camper_name: 'Avi', account: { balance: 3, autoReload: JSON.parse(JSON.stringify(state)) } }];
T.rpc.update_canteen_autoreload_state = (a: any) => { state = a.p_autoreload; return { success: true }; };
const claims: Record<string, any> = {};
T.rpc.claim_refund_intent = (a: any) => { const k = a.p_camp_id + '|' + a.p_key; if (claims[k]) return { claimed: false, previous: {} }; claims[k] = 1; return { claimed: true }; };
T.rpc.release_refund_intent = (a: any) => { delete claims[a.p_camp_id + '|' + a.p_key]; return true; };
T.fetch = async (url: string) => { if (url.endsWith('/payment_intents')) { await new Promise(r => setTimeout(r, 200)); return ${JSON.stringify(piAnswer)}; } return {}; };
let real: any;
Object.defineProperty(T, 'handler', { get() { return async (_req: Request) => {
  const mk = () => new Request('http://edge.test/fn', { method: 'POST', headers: { 'x-cron-secret': 'c', 'content-type': 'application/json' }, body: JSON.stringify({}) });
  const [a] = await Promise.all([real(mk()), real(mk())]); return a; }; }, set(h) { real = h; } });
T.request = { body: {} };
`;
const charges = r => r.fetches.filter(f => f.method === 'POST' && f.url.endsWith('/payment_intents'));

test('TED-075: two top-up checks at once charge the parent\'s card once', () => {
    const r = runEdge('canteen-auto-reload', TWICE({ id: 'pi_1', status: 'succeeded' }));
    assert.strictEqual(charges(r).length, 1, 'the reload was charged ' + charges(r).length + ' times');
    assert.ok(charges(r)[0].headers['Idempotency-Key'], 'no Idempotency-Key on the reload charge');
});

test('a declined reload gives the claim back, so a later check can try again', () => {
    const r = runEdge('canteen-auto-reload', TWICE({ error: { message: 'Your card was declined.' } }));
    assert.ok(r.rpcs.some(x => x.name === 'release_refund_intent'), 'a declined reload kept its claim');
});

test('TED-085: a retry after a declined reload is a new Stripe request, not a replay of the decline', () => {
    const r = runEdge('canteen-auto-reload', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'c' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: null }];
let state: any = { enabled: true, cardOnFile: true, stripeCustomerId: 'cus_P', thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 50 };
T.rpc.canteen_autoreload_accounts = () => [{ camp_id: 'camp1', resolvable: true, person_id: 7, camper_name: 'Avi', account: { balance: 3, autoReload: JSON.parse(JSON.stringify(state)) } }];
T.rpc.update_canteen_autoreload_state = (a: any) => { state = a.p_autoreload; return { success: true }; };
const claims: Record<string, any> = {};
T.rpc.claim_refund_intent = (a: any) => { if (claims[a.p_key]) return { claimed: false, previous: {} }; claims[a.p_key] = 1; return { claimed: true }; };
T.rpc.release_refund_intent = (a: any) => { delete claims[a.p_key]; return true; };
let n = 0;
T.fetch = (url: string) => url.endsWith('/payment_intents') ? (n++ === 0 ? { __status: 402, error: { message: 'Your card was declined.' } } : { id: 'pi_2', status: 'succeeded' }) : {};
const req = { headers: { 'x-cron-secret': 'c' }, body: {} };
T.requests = [req, req];`);
    const k = charges(r).map(c => c.headers['Idempotency-Key']);
    assert.strictEqual(k.length, 2, 'the retry did not reach Stripe');
    assert.notStrictEqual(k[0], k[1], 'Stripe would replay the decline for 24 hours');
});

test('TED-085: a reload Stripe left unfinished gives its slot back and counts as a failure', () => {
    const r = runEdge('canteen-auto-reload', TWICE({ id: 'pi_x', status: 'requires_payment_method' }));
    assert.ok(r.rpcs.some(x => x.name === 'release_refund_intent'), 'the slot was held for the rest of the day');
});

test('TED-094: a Stripe server error is not a decline — the retry repeats the same key', () => {
    const r = runEdge('canteen-auto-reload', `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'c' };
T.tables.camps = [{ id: 'camp1', owner: 'u-owner', payment_processor_key: null }];
let state: any = { enabled: true, cardOnFile: true, stripeCustomerId: 'cus_P', thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 50 };
T.rpc.canteen_autoreload_accounts = () => [{ camp_id: 'camp1', resolvable: true, person_id: 7, camper_name: 'Avi', account: { balance: 3, autoReload: JSON.parse(JSON.stringify(state)) } }];
T.rpc.update_canteen_autoreload_state = (a: any) => { state = a.p_autoreload; return { success: true }; };
const claims: Record<string, any> = {};
T.rpc.claim_refund_intent = (a: any) => { if (claims[a.p_key]) return { claimed: false, previous: {} }; claims[a.p_key] = 1; return { claimed: true }; };
T.rpc.release_refund_intent = (a: any) => { delete claims[a.p_key]; return true; };
let n = 0;
T.fetch = (url: string, init: any) => url.endsWith('/payment_intents') ? (n++ === 0 ? { __status: 500, error: { type: 'api_error', message: 'boom' } } : { id: 'pi_2', status: 'succeeded' }) : {};
const req = { headers: { 'x-cron-secret': 'c' }, body: {} };
T.requests = [req, req];`);
    const k = charges(r).map(c => c.headers['Idempotency-Key']);
    assert.strictEqual(k.length, 2);
    assert.strictEqual(k[0], k[1], 'a new key after a server error could charge the parent twice');
});
