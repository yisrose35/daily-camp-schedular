// Probe (16th pass, hunt): a cheque recorded on the FINANCE page's
// "+ Record Payment" (finAddPayment) — what does the nightly autopay run do?
// The REAL runner (charge-due-installments) on the REAL chain (plan_due_for →
// plan_due → family_ledger_balance are the real SQL), a pretend Cardknox that
// remembers each sale.
//   Gold and Silver each owe $1,000 of tuition, on a one-instalment autopay plan
//   due today, card on file.
//   Gold paid $1,000 by cheque; the office recorded it on Finance → Revenue →
//     "+ Record Payment": saved exactly the way finAddPayment saves it
//     ({id: <ms>, family:'Gold', amount, method:'check', date, status:'paid'}
//     in finance.payments / camp_payments — no familyKey, no ledger entry; my
//     browser run cash_discount16 D5 showed the real page leaves the ledger
//     untouched).
//   Silver (control) paid $1,000 by cheque recorded in Billing → Record Payment
//     (a payment row WITH its ledger entry, the way openPaymentForFamily posts it).
// Run: node ted/probes/2026-09-24-billing-16/finance_page_payment16.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdge } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5698 });
const TODAY = new Date().toISOString().split('T')[0];
const OWNER = '0ed16200-0000-0000-0000-0000000000a1';
const C = '0ed16200-0000-0000-0000-000000000001';
const RPCS = ['camp_families_object', 'camp_payments_array', 'plan_due_for', 'record_autopay_charge', 'hold_autopay_charge',
  'flag_plan_collection', 'record_processor_transaction', 'flag_expiring_cards'];
const BR = bridge(db, RPCS, []);
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const q = (s) => db.sql(`SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);` + s).trim().split('\n').pop();
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
try {
  db.sql(`CREATE TABLE ted_sales (id serial, who text, cents int, ref text); INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t16');
    INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'Camp F', 'cardknox');`);
  const plan = (id) => ({ id, dueDates: [TODAY], count: 1, nextIndex: 0, history: [], autopay: true, paused: false });
  const fam = (name, tok, extra) => Object.assign({ name, camperIds: [name + ' Kid'], cardOnFile: true, byopCustomerRef: tok, byopProcessor: 'cardknox',
    entries: [{ id: 'c_' + tok, kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-01' }], plans: [plan('plan_' + tok)] }, extra || {});
  const t = Date.now();
  const silverPay = { id: 'pay_' + t + '_abcde', family: 'Silver', familyKey: 'silver', amount: 1000, date: TODAY, method: 'check', reference: '', notes: '', timestamp: t };
  const fams = {
    gold: fam('Gold', '111'),
    silver: fam('Silver', '222', { entries: [{ id: 'c_222', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-01' },
      { id: 'le_pay_' + silverPay.id, kind: 'payment', amount: 1000, reason: 'check', date: TODAY, note: 'Payment', by: 'system', source: { paymentId: silverPay.id } }] }),
  };
  // Gold's row exactly as finAddPayment builds it (campistry_me.js:16192)
  const goldPay = { id: t + 1, family: 'Gold', amount: 1000, method: 'check', date: TODAY, status: 'paid' };
  db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}','campistryMe', jsonb_build_object('families', ${lit(fams)}, 'finance', jsonb_build_object('payments', ${lit([goldPay, silverPay])})));`);
  console.log('sync_camp_billing → ' + q(`SELECT public.sync_camp_billing('${C}', ${lit(fams)}, '[]'::jsonb, ${lit([goldPay, silverPay])}, '[]'::jsonb)::text`));
  const owes = (k) => q(`SELECT public.family_ledger_balance(public.camp_family('${C}','${k}'))`);
  const due = (k) => q(`SELECT public.plan_due_for('${C}'::uuid, '${k}', 'plan_${k === 'gold' ? '111' : '222'}', '${TODAY}')::text`);
  console.log(`BEFORE THE NIGHT: payments on file ${q(`SELECT public.camp_payments_array('${C}')::text`).slice(0, 300)}`);
  console.log(`  Gold owes (ledger) $${owes('gold')}; plan_due_for → ${due('gold')}`);
  console.log(`  Silver owes (ledger) $${owes('silver')}; plan_due_for → ${due('silver')}`);

  const scen = `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron' };
T.tables.camp_state_kv = [{ camp_id: '${C}', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.tables.camps = [{ id: '${C}', name: 'Camp F', payment_processor_key: 'cardknox' }];
${BR}
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck', sourceKey: 's', pin: 'p' } });
T.rpc.retry_failed_tip_transfers = () => [];
const __qq = (T as any).__q;
T.fetch = (url: string, init: any) => {
  const body = String(init.body || '');
  if (body.includes('cc%3Asale')) {
    const p = new URLSearchParams(body); const who = p.get('xToken') === '111' ? 'Gold' : 'Silver';
    const ref = String(9000 + Number(__qq("SELECT count(*) FROM ted_sales")) + 1);
    __qq("INSERT INTO ted_sales (who, cents, ref) VALUES ('" + who + "'," + Math.round(Number(p.get('xAmount')) * 100) + ",'" + ref + "')");
    return 'xResult=A&xRefNum=' + ref + '&xStatus=Approved';
  }
  return {};
};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`;
  const r = runEdge('charge-due-installments', scen);
  const details = (r.body && r.body.details || []).filter(d => d.family).map(d => `${d.family}:${d.result}${d.amount != null ? ' $' + d.amount : ''}`);
  console.log(`\nTHE NIGHT: HTTP ${r.status}; results ${JSON.stringify(details)}`);
  const sales = q(`SELECT coalesce(string_agg(who || ' $' || (cents/100.0)::numeric(10,2), ', ' ORDER BY id), 'none') FROM ted_sales`);
  console.log(`  card sales made: ${sales}`);
  console.log(`  after: Gold owes $${owes('gold')}, Silver owes $${owes('silver')}`);
  const goldSales = Number(q(`SELECT count(*) FROM ted_sales WHERE who='Gold'`));
  const silverSales = Number(q(`SELECT count(*) FROM ted_sales WHERE who='Silver'`));
  check(silverSales === 0, 'control: Silver (cheque recorded in Billing) is not charged', `${silverSales} sale(s)`);
  check(goldSales === 0, 'Gold (cheque recorded on the Finance page) is not charged again', `${goldSales} sale(s): ${sales} — Gold paid $1,000 by cheque AND was charged by card`);
} catch (e) { bad++; console.log('ERROR', String(e.stack || e.message).slice(0, 2000)); }
finally { db.stop && db.stop(); console.log(`\n${bad} BAD`); }
