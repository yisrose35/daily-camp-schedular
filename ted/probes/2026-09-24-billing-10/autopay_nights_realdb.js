// Probe (10th pass, TED-113 re-check). The REAL nightly runner
// (charge-due-installments) against the REAL chain on a scratch Postgres (the
// family/plan functions: camp_families_object, plan_due_for,
// record_autopay_charge, hold_autopay_charge, flag_plan_collection ... are the
// real SQL, so what night 1 writes is what night 2 reads). Pretend processors
// remember their sales in the same database.
//   K. Cardknox camp, Gold then Silver each owe $500 tonight. Night 1: Gold's
//      sale goes through but the answer is lost. Night 2. The office answers
//      "went through" (ref 9001) in Billing (276, as the owner). Night 3.
//   B. Banquest camp: Gold's charge answers 504 with no body.
//   S1. Stripe camp: Gold's first POST is cut off after Stripe charged; the
//      runner asks again with the same key.
//   S2. Stripe camp: Stripe answers 500 every time for Gold.
//   X. Cardknox camp: Gold's family record is malformed in a way nobody
//      foresaw (plans[0].dueDates is a string) — does Silver still get charged?
// Run: node ted/probes/2026-09-24-billing-10/autopay_nights_realdb.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdge } = require(R + '/tests/edge_harness.js');
const { bridge } = require('./realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5568 });
const TODAY = new Date().toISOString().split('T')[0];
const OWNER = '0ed30000-0000-0000-0000-0000000000a1';
const RPCS = ['camp_families_object', 'camp_payments_array', 'plan_due_for', 'record_autopay_charge', 'hold_autopay_charge',
  'flag_plan_collection', 'record_processor_transaction', 'flag_expiring_cards'];
const BR = bridge(db, RPCS, []);
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const q = (s) => db.sql(`SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);` + s).trim().split('\n').pop();
db.sql(`CREATE TABLE ted_sales (id serial, camp text, who text, cents int, ref text); CREATE TABLE ted_skeys (k text PRIMARY KEY, resp jsonb);
  INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t');`);
try { db.sql("INSERT INTO payment_processor_catalog SELECT (jsonb_populate_record(null::payment_processor_catalog, (SELECT to_jsonb(c) || '{\"key\":\"banquest\",\"label\":\"Banquest\"}'::jsonb FROM payment_processor_catalog c WHERE key='cardknox'))).* WHERE NOT EXISTS (SELECT 1 FROM payment_processor_catalog WHERE key='banquest')"); } catch (e) { console.log('catalog:', String(e.message).split('\n')[0]); }
let n = 0;
function campWith(proc, goldPlansOverride) {
  n++; const C = `0ed30000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const plan = (id) => ({ id, dueDates: [TODAY, '2099-01-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false });
  const fam = (name, tok, pid) => ({ name, camperIds: [name + ' Kid'], cardOnFile: true, byopCustomerRef: tok, byopProcessor: proc === 'stripe' ? null : proc,
    stripeCustomerId: 'cus_' + tok, stripePaymentMethodId: 'pm_' + tok,
    entries: [{ id: 'c_' + tok, kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-01' }], plans: [plan(pid)] });
  const fams = { gold: fam('Gold', '111', 'plan_g'), silver: fam('Silver', '222', 'plan_s') };
  if (goldPlansOverride) fams.gold.plans = goldPlansOverride;
  db.sql(`INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}', '${OWNER}', 'Camp ${n}', '${proc}');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}','campistryMe', jsonb_build_object('families', ${lit(fams)}));`);
  q(`SELECT public.sync_camp_billing('${C}', ${lit(fams)}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text`);
  return C;
}
function night(C, proc, mode) {
  const scen = `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', INSTALLMENT_CRON_SECRET: 'cron', STRIPE_SECRET_KEY: 'sk_test' };
T.tables.camp_state_kv = [{ camp_id: '${C}', key: 'campistryMe', value: { enrollments: {}, sessions: [] } }];
T.tables.camps = [{ id: '${C}', name: 'Camp', payment_processor_key: ${proc === 'stripe' ? 'null' : `'${proc}'`} }];
${BR}
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck', sourceKey: 's', pin: 'p' } });
T.rpc.retry_failed_tip_transfers = () => [];
const __qq = (T as any).__q;
const sale = (who: string, cents: number, ref: string) => __qq("INSERT INTO ted_sales (camp, who, cents, ref) VALUES ('${C}','" + who + "'," + cents + ",'" + ref + "')");
const MODE = ${JSON.stringify(mode)};
T.fetch = (url: string, init: any) => {
  const body = String(init.body || '');
  if (body.includes('cc%3Asale')) {
    const p = new URLSearchParams(body); const tok = p.get('xToken'); const who = tok === '111' ? 'Gold' : 'Silver';
    const ref = String(9000 + Number(__qq("SELECT count(*) FROM ted_sales")) + 1);
    sale(who, Math.round(Number(p.get('xAmount')) * 100), ref);
    if (MODE === 'drop' && who === 'Gold') throw new Error('connection reset by peer');
    return 'xResult=A&xRefNum=' + ref + '&xStatus=Approved';
  }
  if (url.endsWith('/transactions/charge')) {
    const b = JSON.parse(body); const who = b.source === 'tkn-111' ? 'Gold' : 'Silver';
    const ref = String(7000 + Number(__qq("SELECT count(*) FROM ted_sales")) + 1);
    sale(who, Math.round(b.amount * 100), ref);
    if (MODE === '504' && who === 'Gold') return { __status: 504 };
    return { status_code: 'A', status: 'Approved', reference_number: Number(ref) };
  }
  if (init.method === 'POST' && url.endsWith('/payment_intents')) {
    const p = new URLSearchParams(body); const who = p.get('customer') === 'cus_111' ? 'Gold' : 'Silver';
    if (MODE === '500' && who === 'Gold') return { __status: 500, error: { type: 'api_error', message: 'An unknown error occurred' } };
    const k = init.headers['Idempotency-Key'];
    let resp = JSON.parse(__qq("SELECT resp::text FROM ted_skeys WHERE k = '" + k.replace(/'/g, "''") + "'") || 'null');
    if (!resp) { const id = 'pi_' + who + '_' + (Number(__qq("SELECT count(*) FROM ted_sales")) + 1); sale(who, Number(p.get('amount')), id);
      resp = { id, status: 'succeeded', amount: Number(p.get('amount')) };
      __qq("INSERT INTO ted_skeys VALUES ('" + k.replace(/'/g, "''") + "', '" + JSON.stringify(resp) + "'::jsonb)");
      if (MODE === 'throw-first' && who === 'Gold') throw new Error('connection reset'); }
    return resp;
  }
  return {};
};
T.request = { headers: { 'x-cron-secret': 'cron' }, body: {} };`;
  const DENO_ONERROR = { transform: (fn) => fn + "\n{ const T = (globalThis as any).__T; const h = T.handler; T.handler = async (r: any) => { try { return await h(r); } catch (e) { T.tables.__thrown = [String((e as Error).message)]; return new Response('Internal Server Error', { status: 500 }); } }; }\n" };
  const r = runEdge('charge-due-installments', scen, DENO_ONERROR);
  const details = (r.body && r.body.details || []).filter(d => d.family).map(d => `${d.family}:${d.result}${d.reason ? ' (' + String(d.reason).slice(0, 60) + ')' : ''}`);
  const notes = (r.writes || []).filter(w => w.table === 'notifications' && w.op === 'insert').map(w => w.payload.source + ' ' + w.payload.source_id);
  return { status: r.status, thrown: r.tables.__thrown, details, notes };
}
function books(C) {
  const fams = JSON.parse(q(`SELECT public.camp_families_object('${C}')::text`));
  return Object.entries(fams).map(([k, f]) => {
    const p = (f.plans || [])[0] || {};
    const pays = (f.entries || []).filter(e => e.kind === 'payment').map(e => '$' + e.amount);
    return `${f.name}: paid entries [${pays.join(',')}] history ${JSON.stringify((Array.isArray(p.history) ? p.history : []).map(h => h.index + ':' + h.charged + (h.reason ? '(' + h.reason + ')' : '')))}${p.pendingCharge ? ' HOLD ' + JSON.stringify({ unconfirmed: p.pendingCharge.unconfirmed, amount: p.pendingCharge.amount }) : ''}${p.collectionBlocked ? ' BLOCKED ' + p.collectionBlocked.reason : ''}`;
  }).join(' | ');
}
const sales = (C) => q(`SELECT coalesce(string_agg(who || ' $' || (cents/100.0)::numeric(10,2) || ' (' || ref || ')', ', ' ORDER BY id), 'none') FROM ted_sales WHERE camp='${C}'`);
function show(label, C, r) {
  console.log(`  ${label}: HTTP ${r.status}${r.thrown ? ' THREW ' + r.thrown : ''} | results ${JSON.stringify(r.details)} | notices ${JSON.stringify(r.notes)}`);
  console.log(`     processor sales so far: ${sales(C)}`);
  console.log(`     books: ${books(C)}`);
}
try {
  console.log('K. Cardknox, Gold\'s answer lost on night 1');
  let C = campWith('cardknox');
  show('night 1', C, night(C, 'cardknox', 'drop'));
  show('night 2', C, night(C, 'cardknox', 'ok'));
  console.log('  office answers "went through" (9001) →', q(`SELECT public.resolve_unconfirmed_autopay('${C}','gold','plan_g',true,'9001')::text`));
  show('night 3', C, night(C, 'cardknox', 'ok'));
  console.log('B. Banquest, Gold\'s charge answers 504 with no body');
  C = campWith('banquest'); show('night 1', C, night(C, 'banquest', '504'));
  console.log('S1. Stripe, Gold\'s first request cut off after Stripe charged');
  C = campWith('stripe'); show('night 1', C, night(C, 'stripe', 'throw-first'));
  console.log('S2. Stripe answers 500 every time for Gold');
  C = campWith('stripe'); show('night 1', C, night(C, 'stripe', '500'));
  show('night 2', C, night(C, 'stripe', 'ok'));
  console.log('X. Cardknox, Gold\'s plan record is malformed (dueDates is a string)');
  C = campWith('cardknox', [{ id: 'plan_g', dueDates: 'oops', autopay: true, nextIndex: 0 }]);
  show('night 1', C, night(C, 'cardknox', 'ok'));
} catch (e) { console.log('ERROR', String(e.stack || e.message).slice(0, 2000)); }
finally { db.stop && db.stop(); }
