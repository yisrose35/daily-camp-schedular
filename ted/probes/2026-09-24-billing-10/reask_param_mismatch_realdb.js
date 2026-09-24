// Probe (10th pass): a stale Stripe canteen hold is re-asked (Refund All's
// settleWaitingRefunds, and the single refund's re-ask of other holds). The
// re-ask first GETs the PaymentIntent to decide reverse_transfer, but does not
// check whether that GET failed. Canteen top-ups are destination charges, so the
// ORIGINAL refund carried reverse_transfer=true. Stripe (documented) refuses a
// reused Idempotency-Key whose parameters differ — an idempotency_error, HTTP
// 400 — and the function treats every non-409/429 4xx as a definite "no".
// Real functions + real 275 SQL (scratch DB); pretend Stripe that enforces
// "same key, same parameters" and answers the PI GET with a 429 once.
// Run: node ted/probes/2026-09-24-billing-10/reask_param_mismatch_realdb.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require('./realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5570 });
const RPCS = ['canteen_refund_view', 'reserve_canteen_refund', 'settle_canteen_refund_hold', 'release_canteen_refund_hold',
  'claim_refund_intent', 'settle_refund_intent', 'release_refund_intent', 'release_stale_refund_intent',
  'refund_canteen_deposit_from_stripe', 'record_processor_transaction'];
const BR = bridge(db, RPCS, ['refund_intents']);
const q1 = (s) => db.sql(s).trim();
const C = '0ed40000-0000-0000-0000-000000000001';
db.sql(`CREATE TABLE ted_keys (k text PRIMARY KEY, params text, resp jsonb, status int);
  CREATE TABLE ted_money (id serial, ref text, cents int); CREATE TABLE ted_flags (k text PRIMARY KEY, n int);
  INSERT INTO auth.users (id, email) VALUES ('0ed40000-0000-0000-0000-0000000000a1','o@ted');
  INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','0ed40000-0000-0000-0000-0000000000a1','P','stripe');
  INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 7, 'camper', 'Avi', 'Avi');
  SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 0}'::jsonb);
  SELECT public.canteen_post('${C}', 'Avi', '{"type":"credit","kind":"deposit","method":"stripe","stripePaymentIntentId":"pi_top","amount":50,"date":"2026-07-01","timestamp":1}'::jsonb);
  SELECT public.canteen_post('${C}', 'Avi', '{"type":"debit","kind":"purchase","amount":30,"date":"2026-07-02","timestamp":2}'::jsonb);
  SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 20, "balanceFloor": 0}'::jsonb);`);
const scen = (body, extra) => `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: '${C}', owner: 'u-owner', payment_processor_key: 'stripe' }];
${BR}
const __qq = (T as any).__q;
const __flag = (k: string) => { const n = Number(__qq("SELECT coalesce((SELECT n FROM ted_flags WHERE k='" + k + "'),0)")); if (n > 0) { __qq("UPDATE ted_flags SET n = n - 1 WHERE k='" + k + "'"); return true; } return false; };
T.fetch = async (url: string, init: any) => {
  if (init.method === 'GET' && url.includes('/payment_intents/')) {
    if (__flag('get429')) return { __status: 429, error: { type: 'rate_limit_error', message: 'Too many requests' } };
    return { id: 'pi_top', transfer_data: { destination: 'acct_CAMP' } };
  }
  if (init.method === 'POST' && url.endsWith('/refunds')) {
    const k = String(init.headers['Idempotency-Key']); const params = String(init.body);
    const seen = JSON.parse(__qq("SELECT json_build_object('params', params, 'resp', resp, 'status', status)::text FROM ted_keys WHERE k='" + k.replace(/'/g, "''") + "'") || 'null');
    if (seen) {
      if (seen.params !== params) return { __status: 400, error: { type: 'idempotency_error', message: "Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '" + k + "' if you meant to execute a different request." } };
      if (__flag('lose')) throw new Error('connection reset');
      return Object.assign({ __status: seen.status }, seen.resp);
    }
    const cents = Number(new URLSearchParams(params).get('amount')); const pi = String(new URLSearchParams(params).get('payment_intent'));
    const room = ({ pi_top: 5000, pi_top2: 3000 } as any)[pi] - Number(__qq("SELECT coalesce(sum(cents),0) FROM ted_money WHERE ref='" + pi + "'"));
    if (cents > room) { const e = { error: { type: 'invalid_request_error', message: room <= 0 ? 'Charge ' + pi + ' has already been refunded.' : 'Refund amount is greater than unrefunded amount on charge' } };
      __qq("INSERT INTO ted_keys VALUES ('" + k.replace(/'/g, "''") + "','" + params.replace(/'/g, "''") + "','" + JSON.stringify(e).replace(/'/g, "''") + "'::jsonb, 400)");
      return Object.assign({ __status: 400 }, e); }
    const id = __qq("INSERT INTO ted_money (ref, cents) VALUES ('" + pi + "', " + cents + ") RETURNING 're_' || id");
    const resp = { id, status: 'succeeded', amount: cents };
    __qq("INSERT INTO ted_keys VALUES ('" + k.replace(/'/g, "''") + "','" + params.replace(/'/g, "''") + "','" + JSON.stringify(resp) + "'::jsonb, 200)");
    if (__flag('lose')) throw new Error('connection reset');
    return resp;
  }
  return {};
};
T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body)} }];
${extra || ''}`;
const state = () => `money back to the parent $${q1(`SELECT coalesce(sum(cents),0)/100.0 FROM ted_money`)} | wallet $${q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND account_key='Avi'`)} | holds [${q1(`SELECT coalesce(string_agg(state || ' $' || amount, ', '), 'none') FROM canteen_refund_holds WHERE camp_id='${C}'`)}]`;
try {
  db.sql(`INSERT INTO ted_flags VALUES ('lose', 1)`);
  let r = runEdges(['stripe-canteen-refund-all'], scen({}));
  console.log(`1. Refund All: Stripe refunds Avi's $20, the answer is lost → ${JSON.stringify(r.responses[0].body.details?.[0]?.error || r.responses[0].body).slice(0, 110)}`);
  console.log(`   ${state()}`);
  db.sql(`UPDATE canteen_refund_holds SET created_at = now() - interval '10 minutes'; INSERT INTO ted_flags VALUES ('get429', 1) ON CONFLICT (k) DO UPDATE SET n = 1;`);
  r = runEdges(['stripe-canteen-refund-all'], scen({}));
  console.log(`2. ten minutes later, Refund All again; Stripe rate-limits the PaymentIntent lookup once (429) → ${JSON.stringify(r.responses[0].body).slice(0, 200)}`);
  console.log(`   ${state()}`);
  console.log(`   Refund lines on Avi's canteen ledger: ${q1(`SELECT count(*) FROM canteen_transactions WHERE camp_id='${C}' AND payload->>'kind'='refund'`)}`);
  // ── variant: the re-ask made by a SINGLE refund of the same child ──
  const C2 = '0ed40000-0000-0000-0000-000000000002';
  db.sql(`TRUNCATE ted_keys, ted_money; DELETE FROM ted_flags;
    INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C2}','0ed40000-0000-0000-0000-0000000000a1','P2','stripe');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C2}', 7, 'camper', 'Avi', 'Avi');
    SELECT public.canteen_account_save('${C2}', 'Avi', '{"balance": 0}'::jsonb);
    SELECT public.canteen_post('${C2}', 'Avi', '{"type":"credit","kind":"deposit","method":"stripe","stripePaymentIntentId":"pi_top","amount":50,"date":"2026-07-01","timestamp":1}'::jsonb);
    SELECT public.canteen_account_save('${C2}', 'Avi', '{"balance": 50, "balanceFloor": 0}'::jsonb);
    INSERT INTO ted_flags VALUES ('lose', 1);`);
  const s2 = (b, x) => scen(b, x).split("'" + C + "'").join("'" + C2 + "'");
  const st2 = () => `money back to the parent $${q1(`SELECT coalesce(sum(cents),0)/100.0 FROM ted_money`)} (${q1(`SELECT coalesce(string_agg(ref || ' $' || (cents/100.0)::numeric(10,2), ', ' ORDER BY id),'none') FROM ted_money`)}) | wallet $${q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C2}' AND account_key='Avi'`)} | holds [${q1(`SELECT coalesce(string_agg(state || ' $' || amount, ', '), 'none') FROM canteen_refund_holds WHERE camp_id='${C2}'`)}]`;
  r = runEdges(['stripe-canteen-refund-all'], s2({}));
  console.log(`V1. Refund All refunds Avi's $50 (his whole $50 top-up); the answer is lost → ${st2()}`);
  // the parent tops Avi up $30 more (pi_top2)
  db.sql(`SELECT public.canteen_post('${C2}', 'Avi', '{"type":"credit","kind":"deposit","method":"stripe","stripePaymentIntentId":"pi_top2","amount":30,"date":"2026-07-05","timestamp":3}'::jsonb);
    UPDATE camp_canteen_accounts SET balance = balance + 30 WHERE camp_id='${C2}' AND account_key='Avi';
    UPDATE canteen_refund_holds SET created_at = now() - interval '10 minutes' WHERE camp_id='${C2}';
    INSERT INTO ted_flags VALUES ('get429', 1) ON CONFLICT (k) DO UPDATE SET n = 1;`);
  console.log(`V2. Avi is topped up $30 more (a second payment); wallet now shows $30 → ${st2()}`);
  r = runEdges(['stripe-canteen-refund'], s2({ camperId: 7, camperName: 'Avi', amount: 30, idempotencyKey: 'cref_V3' }));
  console.log(`V3. the office refunds Avi's $30; Stripe rate-limits the lookup once (429) → HTTP ${r.responses[0].status} ${JSON.stringify(r.responses[0].body).slice(0, 180)}`);
  console.log(`    ${st2()}`);
} catch (e) { console.log('ERROR', String(e.stack || e.message).slice(0, 1500)); }
finally { db.stop && db.stop(); }
