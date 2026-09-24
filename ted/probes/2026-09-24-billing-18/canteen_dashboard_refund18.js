// Probe (18th pass, hunt). The REAL stripe-webhook on real SQL (realdb bridge).
// A parent put $20 on Avi's canteen wallet by card (a real top-up: the
// webhook's own payment_intent.succeeded, credit_canteen_balance_from_stripe).
// Then the camp — or Campistry's platform — refunds it in the STRIPE
// DASHBOARD (the webhook's own comment: "which people do constantly"), or the
// parent disputes it with their bank.
//   C1 charge.refunded for the top-up → Avi's wallet?
//   C2 a second child's $20 top-up is disputed (charge.dispute.created) → wallet?
// Compared with the Snacks page's own card refund, which takes the money off
// the wallet (refund_canteen_deposit_from_stripe).
// Asked: can the child still spend money the parent got back; is anyone told?
// Run: node ted/probes/2026-09-24-billing-18/canteen_dashboard_refund18.js
'use strict';
const crypto = require('node:crypto');
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5767 });
const OWNER = '0ed18800-0000-0000-0000-0000000000a1';
const C = '0ed18800-0000-0000-0000-000000000001';
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const q = (s) => db.sql(s).trim();
try {
  q(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t18c');
     INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'Canteen Camp', 'stripe');
     INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 1, 'camper', 'Avi Gold', 'Avi Gold'), ('${C}', 2, 'camper', 'Bina Gold', 'Bina Gold');
     SELECT public.canteen_account_save('${C}', 'Avi Gold', '{"balance": 0, "camperId": 1}'::jsonb);
     SELECT public.canteen_account_save('${C}', 'Bina Gold', '{"balance": 0, "camperId": 2}'::jsonb);`);
  const wallet = (id) => q(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND person_id=${id}`);
  const notices = () => q(`SELECT count(*) FROM notifications WHERE camp_id='${C}'`);
  const RPCS = ['credit_canteen_balance_from_stripe', 'record_external_refund', 'record_chargeback', 'resolve_chargeback', 'camp_families_object'];
  const META = (id, name) => ({ campId: C, source: 'campistry-canteen-deposit', camperId: String(id), camperName: name });
  function deliver(event, stripe) {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_ted').update(`${t}.${body}`).digest('hex');
    const scen = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_WEBHOOK_SECRET: 'whsec_ted', RESEND_API_KEY: 're_test' };
T.tables.camps = [{ id: '${C}', owner: '${OWNER}', payment_processor_key: 'stripe' }];
${bridge(db, RPCS, [])}
const ST: any = ${JSON.stringify(stripe || {})};
T.fetch = async (url: string, init: any) => {
  if (url.includes('resend.com')) { (T as any).__emails = ((T as any).__emails || 0) + 1; return { ok: true, status: 200, json: async () => ({}) }; }
  for (const k of Object.keys(ST)) if (url.includes(k)) return { ok: true, status: 200, json: async () => ST[k] };
  return { ok: true, status: 200, json: async () => ({}) };
};
T.requests = [{ headers: { 'stripe-signature': 't=${t},v1=' + ${JSON.stringify(sig)} }, rawBody: ${JSON.stringify(body)} }];`;
    const r = runEdges(['stripe-webhook'], scen);
    return { status: r.responses[0].status, emails: (r.fetches || []).filter(f => String(f.url).includes('resend.com')).length, log: (r.logs || []).join(' ').slice(0, 300) };
  }
  const topup = (pi, id, name) => ({ id: 'evt_' + pi, type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
    data: { object: { id: pi, object: 'payment_intent', amount: 2000, amount_received: 2000, status: 'succeeded', payment_method_types: ['card'], metadata: META(id, name) } } });
  deliver(topup('pi_c1', 1, 'Avi Gold')); deliver(topup('pi_c2', 2, 'Bina Gold'));
  console.log(`SETUP: $20 top-ups by card → Avi $${wallet(1)}, Bina $${wallet(2)}`);

  console.log('\nC1. the $20 top-up for Avi is refunded in the Stripe Dashboard');
  const re = { id: 're_c1', object: 'refund', amount: 2000, status: 'succeeded', charge: 'ch_c1', payment_intent: 'pi_c1' };
  const c1 = deliver({ id: 'evt_r1', type: 'charge.refunded', data: { object: { id: 'ch_c1', object: 'charge', amount: 2000, amount_refunded: 2000, refunded: true, payment_intent: 'pi_c1', metadata: META(1, 'Avi Gold'), refunds: { data: [re] } } } },
    { '/refunds/re_c1': re, '/payment_intents/pi_c1': { id: 'pi_c1', metadata: META(1, 'Avi Gold') } });
  console.log(`    webhook HTTP ${c1.status}; Avi's wallet $${wallet(1)}; camp notices ${notices()}; platform emails ${c1.emails}`);
  check(Number(wallet(1)) === 0 || Number(notices()) > 0 || c1.emails > 0, 'C1 the refunded $20 comes off Avi\'s wallet (or someone is told)',
    `the parent has the $20 back on their card, Avi can still spend $${wallet(1)}, nobody told`);

  console.log('\nC2. Bina\'s $20 top-up is disputed with the bank');
  const dp = { id: 'dp_c2', object: 'dispute', amount: 2000, charge: 'ch_c2', payment_intent: 'pi_c2', reason: 'fraudulent', status: 'needs_response', metadata: {} };
  const c2 = deliver({ id: 'evt_d2', type: 'charge.dispute.created', data: { object: dp } },
    { '/payment_intents/pi_c2': { id: 'pi_c2', metadata: META(2, 'Bina Gold') }, '/charges/ch_c2': { id: 'ch_c2', metadata: META(2, 'Bina Gold') } });
  console.log(`    webhook HTTP ${c2.status}; Bina's wallet $${wallet(2)}; camp notices ${notices()}; platform emails ${c2.emails} (the generic "a parent disputed a charge" risk email)`);
  check(Number(wallet(2)) === 0 || Number(notices()) > 0, 'C2 the disputed $20 comes off Bina\'s wallet, or the camp is told',
    `Bina can still spend $${wallet(2)}; camp notices ${notices()}`);
} catch (e) {
  check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
} finally {
  db.stop();
  console.log(`\n${bad} BAD`);
}
