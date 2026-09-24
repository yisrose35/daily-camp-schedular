// Probe (15th pass, TED-150 re-check). The REAL stripe-webhook with the REAL
// 278/281 SQL (reverse_failed_stripe_refund, undo_card_fee_return,
// claim_refund_failure_alert, release_refund_failure_alert) on a scratch
// Postgres. The email service (Resend) is made to fail on chosen calls.
// Four deliveries of one failure each: refund.failed, a re-send of it,
// refund.updated, charge.refund.updated.
//   A  no camp can be found for the refund (TED-137's path), Resend fails once
//   B  a known camp's booked tuition refund (put back on the family), Resend fails once
//   C  as B, but no RESEND_API_KEY at all
//   D  as B, Resend down for all four deliveries
// Run: node ted/probes/2026-09-24-billing-15/alert_retry_realdb15.js
'use strict';
const crypto = require('node:crypto');
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5677 });
const q1 = (s) => db.sql(s).trim();
const OWNER = '0ed15000-0000-0000-0000-0000000000b1';
db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@ted15b') ON CONFLICT DO NOTHING;`);
const BR = bridge(db, ['reverse_failed_stripe_refund', 'record_external_refund', 'claim_refund_failure_alert', 'release_refund_failure_alert', 'undo_card_fee_return'], []);

let n = 0;
function famCamp() {
  n++;
  const C = `0ed15000-0000-0000-0000-${String(100 + n).padStart(12, '0')}`;
  const pi = `pi_${n}T`, re = `re_${n}T`;
  db.sql(`INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','A${n}','stripe');`);
  const fam = { name: 'Gold', camperIds: ['Dov Gold'], stripeCustomerId: 'cus_gold', entries: [
    { id: 'le_t', kind: 'charge', amount: 500, reason: 'tuition', date: '2026-06-01' },
    { id: 'le_pay_' + pi, kind: 'payment', amount: 500, reason: 'card', date: '2026-06-02', by: 'system', source: { paymentId: pi } },
    { id: 'le_pay_' + re, kind: 'refund', amount: 500, reason: 'refund', date: '2026-09-20', by: 'system', source: { paymentId: re } }] };
  db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', jsonb_build_object('families', jsonb_build_object('gold', '${JSON.stringify(fam)}'::jsonb)));`);
  const payRow = { id: 'pi_' + pi, family: 'Gold', familyKey: 'gold', amount: 500, date: '2026-06-02', method: 'Card', stripePaymentIntentId: pi, status: 'succeeded', timestamp: Date.now() - 20 * 86400000 };
  const refRow = { id: 'ref_1_0', family: 'Gold', familyKey: 'gold', amount: -500, date: '2026-09-20', method: 'Refund', reference: re, refundOf: 'pi_' + pi, stripeRefundId: re, offline: false, timestamp: Date.now() - 3 * 86400000 };
  db.sql(`SELECT public.camp_payment_add('${C}', '${JSON.stringify(payRow)}'::jsonb); SELECT public.camp_payment_add('${C}', '${JSON.stringify(refRow)}'::jsonb);`);
  return { C, pi, re };
}
function run(label, c, meta, failOn, noKey) {
  const obj = { id: c.re, object: 'refund', amount: 50000, status: 'failed', failure_reason: 'expired_or_canceled_card', payment_intent: c.pi, charge: 'ch_' + c.pi, metadata: meta, created: 1790000000 };
  const reqs = ['refund.failed', 'refund.failed', 'refund.updated', 'charge.refund.updated'].map((type, i) => {
    const body = JSON.stringify({ id: 'evt_' + label + i, type, created: Math.floor(Date.now() / 1000), data: { object: obj } });
    const t = Math.floor(Date.now() / 1000);
    return { headers: { 'stripe-signature': `t=${t},v1=${crypto.createHmac('sha256', 'whsec_ted').update(`${t}.${body}`).digest('hex')}` }, rawBody: body };
  });
  const scen = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_WEBHOOK_SECRET: 'whsec_ted'${noKey ? '' : ", RESEND_API_KEY: 're_test'"} };
${BR}
let sends = 0; (globalThis as any).__sent = [];
(globalThis as any).__send = async (m: any) => { sends++; if (${JSON.stringify(failOn)}.includes(sends)) return { data: null, error: { statusCode: 503, message: 'Resend is unavailable' } };
  (globalThis as any).__sent.push(m.subject); return { data: { id: 'em_' + sends }, error: null }; };
T.fetch = async (url: string) => {
  if (url.includes('/payment_intents/')) return { id: '${c.pi}', object: 'payment_intent', metadata: ${JSON.stringify(meta)} };
  if (url.includes('/charges/')) return { id: 'ch_${c.pi}', object: 'charge', metadata: ${JSON.stringify(meta)} };
  if (url.includes('/refunds/${c.re}')) return ${JSON.stringify(obj)};
  return {};
};
T.requests = ${JSON.stringify(reqs)};`;
  const r = runEdges(['stripe-webhook'], scen, { transform: (src) => src.replace('await resend.emails.send({', 'await (globalThis as any).__send({') });
  const sent = r.logs.filter(l => /risk alert email sent/.test(l)).length;
  const failed = r.logs.filter(l => /risk alert email failed/.test(l)).length;
  const owes = meta.campId ? Number(q1(`SELECT public.family_ledger_balance(public.camp_family('${c.C}','gold'))`)) : null;
  const notices = meta.campId ? Number(q1(`SELECT count(*) FROM notifications WHERE camp_id='${c.C}' AND source='refund_failed'`)) : null;
  const putBacks = meta.campId ? Number(q1(`SELECT count(*) FROM camp_payments WHERE camp_id='${c.C}' AND payment_id LIKE 'refail_%' AND deleted_at IS NULL`)) : null;
  console.log(`${label}\n    HTTP ${r.responses.map(x => x.status).join('/')}; email attempts that failed: ${failed}; alert emails that went out: ${sent}` +
    (meta.campId ? `; Gold owes $${owes} (put back ${putBacks}×), office notices ${notices}` : ''));
  return { sent, statuses: r.responses.map(x => x.status), owes, putBacks, notices };
}
let bad = 0;
const verdict = (ok, label) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}`); };
try {
  const a = run('A  no camp found, Resend fails on the first try', famCamp(), {}, [1]);
  verdict(a.sent === 1 && a.statuses[0] === 500 && a.statuses.slice(1).every(s => s === 200), 'A the alert goes out once, on the next delivery');
  const b = run('B  known camp, booked refund, Resend fails on the first try', famCamp(), null || { campId: `0ed15000-0000-0000-0000-${String(102).padStart(12, '0')}` }, [1]);
  verdict(b.sent === 1 && b.owes === 0 && b.putBacks === 1 && b.notices === 1, 'B the alert goes out once; the $500 is put back once; one office notice');
  const c = run('C  known camp, no RESEND_API_KEY', famCamp(), { campId: `0ed15000-0000-0000-0000-${String(103).padStart(12, '0')}` }, [], true);
  verdict(c.statuses.every(s => s === 200) && c.owes === 0 && c.putBacks === 1, 'C nothing to send with: answered 200 (no retry loop), put back once');
  const d = run('D  known camp, Resend down for all four deliveries', famCamp(), { campId: `0ed15000-0000-0000-0000-${String(104).padStart(12, '0')}` }, [1, 2, 3, 4]);
  console.log(`  NOTE D every delivery is answered ${d.statuses.join('/')} — Stripe keeps re-sending while the email service is down; money put back ${d.putBacks}×, owes $${d.owes}`);
} catch (e) { console.log('ERROR', String(e.stack || e.message).slice(0, 1500)); bad++; }
finally { db.stop && db.stop(); }
console.log(`\n${bad} BAD`);
