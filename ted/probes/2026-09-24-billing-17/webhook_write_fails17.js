// Probe (17th pass, hunt): what the REAL stripe-webhook answers Stripe when
// the database write for a SUCCEEDED payment fails once (a statement timeout,
// a dropped connection, a migration missing). All the webhook's RPCs run as
// the REAL SQL on a scratch Postgres (realdb bridge) except the one write,
// which answers the way supabase-js does when the database refuses:
// { data: null, error: { message: 'canceling statement due to statement timeout' } }.
// Stripe's documented rule: a 2xx answer means delivered — it never re-sends;
// any other answer is re-sent for up to 3 days.
//   W1 a parent's Link "Pay Now" $500 (tuition path, append_camp_payment)
//   W2 a parent's canteen top-up $20 (credit_canteen_balance_from_stripe)
//   W3 a photo purchase $8.95 (record_link_photo_purchase)
//   each: HTTP status to Stripe, was the receipt sent, what the family has;
//   then the same event delivered again with the database healthy (what a
//   Stripe re-send would do) — does it record then?
// Run: node ted/probes/2026-09-24-billing-17/webhook_write_fails17.js
'use strict';
const crypto = require('node:crypto');
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5731 });
const OWNER = '0ed17400-0000-0000-0000-0000000000a1', PARENT = '0ed17400-0000-0000-0000-0000000000b2';
const C = '0ed17400-0000-0000-0000-000000000001';
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const q = (s) => db.sql(s).trim();
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
try {
  q(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t17w'), ('${PARENT}','p@t17w');
     INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'Webhook Camp', 'stripe');
     INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 1, 'camper', 'Avi Gold', 'Avi Gold');
     INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', jsonb_build_object('families', ${lit({ gold: { name: 'Gold', camperIds: ['Avi Gold'], entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-06-01' }] } })}));
     SELECT public.canteen_account_save('${C}', 'Avi Gold', '{"balance": 0, "camperId": 1}'::jsonb);`);
  const owes = () => q(`SELECT public.family_ledger_balance(public.camp_family('${C}','gold'))`);
  const wallet = () => q(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND person_id=1`);
  const photos = () => q(`SELECT count(*) FROM link_photo_purchases WHERE camp_id='${C}'`);
  const RPCS = ['append_camp_payment', 'credit_canteen_balance_from_stripe', 'record_link_photo_purchase', 'camp_families_object'];
  function deliver(event, failFn) {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_ted').update(`${t}.${body}`).digest('hex');
    const scen = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_WEBHOOK_SECRET: 'whsec_ted', RESEND_API_KEY: 're_test' };
T.tables.camps = [{ id: '${C}', owner: '${OWNER}', payment_processor_key: 'stripe' }];
${bridge(db, RPCS, [])}
${failFn ? `T.rpc['${failFn}'] = () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { __supabaseError: true }); };` : ''}
T.fetch = async (url, init) => { if (String(url).includes('send-payment-receipt')) { (T as any).__receipts = ((T as any).__receipts || 0) + 1; return { ok: true }; } return {}; };
T.requests = [{ headers: { 'stripe-signature': 't=${t},v1=' + ${JSON.stringify(sig)} }, rawBody: ${JSON.stringify(body)} }];`;
    const r = runEdges(['stripe-webhook'], scen);
    const res = r.responses[0];
    const receipts = (r.fetches || []).filter(f => String(f.url).includes('send-payment-receipt')).length;
    return { status: res.status, body: JSON.stringify(res.body).slice(0, 100), receipts, rpcs: (r.rpcs || []).map(x => x.name || x).join(',') };
  }
  const pi = (id, cents, meta) => ({ id: 'evt_' + id + '_' + Math.random().toString(36).slice(2, 6), type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
    data: { object: { id, object: 'payment_intent', amount: cents, amount_received: cents, status: 'succeeded', payment_method_types: ['card'], metadata: Object.assign({ campId: C }, meta) } } });

  const cases = [
    ['W1', "Link Pay Now $500 (the family's tuition)", pi('pi_w1', 50000, { familyKey: 'gold', familyName: 'Gold' }), 'append_camp_payment', () => `Gold owes $${owes()}`, () => Number(owes()) === 500],
    ['W2', 'canteen top-up $20 for Avi', pi('pi_w2', 2000, { source: 'campistry-canteen-deposit', camperId: '1', camperName: 'Avi Gold' }), 'credit_canteen_balance_from_stripe', () => `Avi's wallet $${wallet()}`, () => Number(wallet()) === 20],
    ['W3', 'photo recognition $8.95 for Avi', pi('pi_w3', 895, { source: 'campistry-link-photo-purchase', kind: 'facial_recognition', parentUserId: PARENT, camperIds: '[1]', camperNames: '["Avi Gold"]' }), 'record_link_photo_purchase', () => `photo purchases on file ${photos()}`, () => Number(photos()) === 1],
  ];
  for (const [id, what, ev, fn, state, recorded] of cases) {
    console.log(`\n${id}. ${what} — Stripe says it succeeded; the database write (${fn}) fails once`);
    const a = deliver(ev, fn);
    console.log(`    webhook answers Stripe HTTP ${a.status} ${a.body}; receipts sent ${a.receipts}; ${state()}`);
    check(a.status >= 500 || recorded(), `${id} a payment that could not be recorded is not answered "received" (Stripe would re-send it)`,
      `HTTP ${a.status} — Stripe marks it delivered and never re-sends; the parent was charged${a.receipts ? ' and sent a receipt' : ''}; ${state()}`);
    const b = deliver(ev, null);
    console.log(`    the same event again, database healthy (only happens if Stripe re-sends): HTTP ${b.status}; ${state()}`);
    check(recorded(), `${id} once re-sent, it is recorded`, state());
  }
} catch (e) {
  check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
} finally {
  db.stop();
  console.log(`\n${bad} BAD`);
}
