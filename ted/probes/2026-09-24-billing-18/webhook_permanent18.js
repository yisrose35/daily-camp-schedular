// Probe (18th pass, hunt after the TED-164 fix). The REAL stripe-webhook on
// real SQL (scratch Postgres, realdb bridge). TED-164 made the webhook answer
// 500 whenever a write for a succeeded payment is not recorded, so Stripe
// re-sends. That is right for a passing database hiccup. What about a payment
// the database will NEVER record — the database refuses it every time?
//   P1 canteen top-up for a child whose number is no longer anyone
//      (erased / merged between checkout and payment) → unknown_camper
//   P2 registration deposit for an application that no longer exists
//      (deleted as a duplicate after the parent paid) → application_not_found
//   P3 control: an ordinary top-up delivered twice → 200 both, credited once
// Each delivered 4 times (Stripe re-sends for up to 3 days, then stops).
// Asked: what Stripe is answered, whether anyone (camp notice, platform
// email) is ever told the money came in and was not recorded.
// Run: node ted/probes/2026-09-24-billing-18/webhook_permanent18.js
'use strict';
const crypto = require('node:crypto');
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5741 });
const OWNER = '0ed18400-0000-0000-0000-0000000000a1';
const C = '0ed18400-0000-0000-0000-000000000001';
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const q = (s) => db.sql(s).trim();
try {
  q(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t18p');
     INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'Webhook Camp', 'stripe');
     INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 1, 'camper', 'Avi Gold', 'Avi Gold');
     SELECT public.canteen_account_save('${C}', 'Avi Gold', '{"balance": 0, "camperId": 1}'::jsonb);`);
  const wallet = () => q(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND person_id=1`);
  const notices = () => q(`SELECT count(*) FROM notifications WHERE camp_id='${C}'`);
  const RPCS = ['credit_canteen_balance_from_stripe', '_record_registration_deposit', '_record_registration_card', 'camp_families_object'];
  function deliver(event) {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_ted').update(`${t}.${body}`).digest('hex');
    const scen = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_WEBHOOK_SECRET: 'whsec_ted', RESEND_API_KEY: 're_test' };
T.tables.camps = [{ id: '${C}', owner: '${OWNER}', payment_processor_key: 'stripe' }];
${bridge(db, RPCS, [])}
T.fetch = async (url, init) => ({ ok: true, status: 200, json: async () => ({}) });
T.requests = [{ headers: { 'stripe-signature': 't=${t},v1=' + ${JSON.stringify(sig)} }, rawBody: ${JSON.stringify(body)} }];`;
    const r = runEdges(['stripe-webhook'], scen);
    const res = r.responses[0];
    const f = r.fetches || [];
    return { status: res.status, body: JSON.stringify(res.body).slice(0, 140),
      receipts: f.filter(x => String(x.url).includes('send-payment-receipt')).length,
      emails: f.filter(x => String(x.url).includes('resend.com')).length };
  }
  const pi = (id, cents, meta) => ({ id: 'evt_' + id + '_' + Math.random().toString(36).slice(2, 6), type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
    data: { object: { id, object: 'payment_intent', amount: cents, amount_received: cents, status: 'succeeded', payment_method_types: ['card'], metadata: Object.assign({ campId: C }, meta) } } });

  const cases = [
    ['P1', 'canteen top-up $20 for child #7 (a number that is no longer anyone)', pi('pi_p1', 2000, { source: 'campistry-canteen-deposit', camperId: '7', camperName: 'Shira Gold' })],
    ['P2', 'registration deposit $250 for an application deleted after the parent paid', pi('pi_p2', 25000, { source: 'registration_deposit', enrollmentId: 'enr_gone' })],
  ];
  for (const [id, what, ev] of cases) {
    console.log(`\n${id}. ${what}`);
    const answers = [];
    let emails = 0, receipts = 0;
    for (let i = 0; i < 4; i++) { const a = deliver(ev); answers.push(a.status); emails += a.emails; receipts += a.receipts; if (i === 0) console.log(`    first answer HTTP ${a.status} ${a.body}`); }
    console.log(`    4 deliveries answered ${JSON.stringify(answers)}; receipts ${receipts}; platform emails ${emails}; camp notices ${notices()}`);
    check(emails > 0 || Number(notices()) > 0, `${id} someone is told a payment came in that can never be recorded`,
      `Stripe gets ${answers.join('/')} for 3 days and then gives up; no email, no notice — the parent paid, nothing is recorded, nobody knows`);
  }
  console.log('\nP3. control: an ordinary $20 top-up for Avi (#1), delivered twice');
  const e3 = pi('pi_p3', 2000, { source: 'campistry-canteen-deposit', camperId: '1', camperName: 'Avi Gold' });
  const a = deliver(e3), b = deliver(e3);
  console.log(`    answers ${a.status}/${b.status}; receipts ${a.receipts}+${b.receipts}; Avi's wallet $${wallet()}`);
  check(a.status === 200 && b.status === 200 && Number(wallet()) === 20, 'P3 credited once, both answered 200', `wallet $${wallet()}`);
} catch (e) {
  check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
} finally {
  db.stop();
  console.log(`\n${bad} BAD`);
}
