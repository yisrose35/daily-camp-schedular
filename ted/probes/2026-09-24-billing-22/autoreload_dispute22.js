// Probe (22nd pass, autoreload_dispute22). The REAL canteen-auto-reload (called
// the way the cron calls it) and the REAL stripe-webhook, on the REAL migration
// chain (4889ba7), with a pretend Stripe that records every charge.
//   A1  Avi's wallet runs low → auto-reload charges his parent's card $20. The
//       parent DISPUTES that $20 with the bank. The webhook takes the $20 off
//       the wallet (TED-181). Next day's run: is the same card charged again?
//   A2  Bea's family (Gold) disputes a TUITION payment: the family is paused
//       (288, disputeHold — "their card will not be charged again"). Bea's
//       weekly canteen auto-reload is on the same Stripe customer. Charged?
//   A0  control: Cy, no dispute anywhere, weekly reload → charged
'use strict';
const crypto = require('node:crypto');
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5827 });
const OWNER = '0ed22a00-0000-0000-0000-0000000000a1';
const C = '0ed22a00-0000-0000-0000-000000000001';
const q = (s) => db.sql(s).trim();
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const now = Date.now();
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
try {
  q(`CREATE TABLE ted_pis (id serial, customer text, cents int, camper text, credited boolean NOT NULL DEFAULT false, day text);
     INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t22a');
     INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','Reload Camp','stripe');
     INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 7, 'camper', 'Avi', 'Avi'), ('${C}', 8, 'camper', 'Bea', 'Bea'), ('${C}', 9, 'camper', 'Cy', 'Cy');
     SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 0, "camperId": 7}'::jsonb);
     SELECT public.canteen_account_save('${C}', 'Bea', '{"balance": 0, "camperId": 8}'::jsonb);
     SELECT public.canteen_account_save('${C}', 'Cy', '{"balance": 0, "camperId": 9}'::jsonb);`);
  const ar = (name, id, cfg) => q(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${C}','${name}');
    PERFORM public.canteen_account_save('${C}','${name}', a || jsonb_build_object('camperId', ${id}, 'autoReload', ${lit(cfg)})); END $x$;`);
  const weekly = (cus) => ({ enabled: true, cardOnFile: true, stripeCustomerId: cus, stripePaymentMethodId: 'pm_' + cus,
    thresholdEnabled: false, scheduleEnabled: true, scheduleFrequency: 'weekly', scheduleDay: new Date(now).getUTCDay(), scheduleReloadAmount: 25, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 });
  ar('Avi', 7, { enabled: true, cardOnFile: true, stripeCustomerId: 'cus_avi', stripePaymentMethodId: 'pm_avi',
    thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 });
  ar('Bea', 8, weekly('cus_gold'));
  ar('Cy', 9, weekly('cus_cy'));
  const sessions = [{ id: 's1', name: 'Summer', startDate: iso(now - 20 * DAY), endDate: iso(now + 30 * DAY), dates: '', tuition: 1000, capacity: 100 }];
  const fams = { gold: { name: 'Gold', camperIds: ['Bea'], cardOnFile: true, stripeCustomerId: 'cus_gold', stripePaymentMethodId: 'pm_cus_gold',
    entries: [{ id: 'c_gold', kind: 'charge', amount: 2000, reason: 'tuition', date: '2026-05-01' }] } };
  q(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', ${lit({ families: fams, enrollments: {}, sessions, sessionBundles: [], enrollSettings: {} })}),
       ('${C}', 'campDates', ${lit({ startDate: sessions[0].startDate, endDate: sessions[0].endDate })});
     SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);
     SELECT public.sync_camp_billing('${C}', ${lit(fams)}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);`);

  const wallet = (id) => q(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND person_id=${id}`);
  const BR = bridge(db, ['canteen_autoreload_accounts', 'update_canteen_autoreload_state', 'claim_refund_intent', 'release_refund_intent'], ['camp_state_kv']);
  function cron(ts) {
    const scen = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'cron_s' };
${BR}
T.rpc.canteen_autoreload_accounts = (a: any) => JSON.parse((T as any).__q("SELECT coalesce(json_agg(x), '[]'::json)::text FROM public.canteen_autoreload_accounts() x WHERE x.camp_id = '${C}'") || '[]');
T.tables.camps = [{ id: '${C}', owner: 'u-owner', payment_processor_key: 'stripe', stripe_account_id: null, stripe_charges_enabled: false, name: 'Reload Camp' }];
const __qq = (T as any).__q;
T.fetch = async (url: string, init: any) => {
  if (init && init.method === 'POST' && url.endsWith('/payment_intents')) {
    const p = new URLSearchParams(String(init.body || ''));
    const r = JSON.parse(__qq("INSERT INTO ted_pis (customer, cents, camper, day) VALUES ('" + String(p.get('customer')) + "'," + Number(p.get('amount')) + ",'" + String(p.get('metadata[camperName]')) + "','" + new Date().toISOString().slice(0, 10) + "') RETURNING row_to_json(ted_pis)::text"));
    return { id: 'pi_reload' + r.id, object: 'payment_intent', amount: r.cents, amount_received: r.cents, status: 'succeeded', customer: r.customer };
  }
  return {};
};
${ts ? `const __RealDate = Date; (globalThis as any).Date = class extends __RealDate { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(${ts}); } static now() { return ${ts}; } };` : ''}
T.requests = [{ headers: { 'x-cron-secret': 'cron_s' }, body: {} }];`;
    const r = runEdges(['canteen-auto-reload'], scen);
    const b = r.responses[0].body || {};
    // the webhook's payment_intent.succeeded, as the real function records it
    for (const row of JSON.parse(q(`SELECT coalesce(json_agg(p), '[]'::json)::text FROM ted_pis p WHERE NOT credited`))) {
      const who = row.camper === 'Avi' ? 7 : row.camper === 'Bea' ? 8 : 9;
      q(`SELECT public.credit_canteen_balance_from_stripe(p_camp_id => '${C}', p_camper_id => ${who}, p_camper_name => '${row.camper}', p_amount => ${row.cents / 100}, p_payment_intent_id => 'pi_reload${row.id}'); UPDATE ted_pis SET credited = true WHERE id = ${row.id};`);
    }
    return (b.details || []).map((d) => d.camper ? `${d.camper} $${d.amount} → ${d.result}` : `camp → ${d.result}`).join('; ') || JSON.stringify(b).slice(0, 200);
  }
  const charges = (cus) => q(`SELECT coalesce(string_agg(day || ' $' || (cents/100), ', ' ORDER BY id), 'none') FROM ted_pis WHERE customer='${cus}'`);

  const RPCS = ['credit_canteen_balance_from_stripe', 'record_external_refund', 'resolve_chargeback', 'camp_families_object', 'hold_autopay_for_dispute', 'note_dispute_lost',
    'record_canteen_stripe_reversal', 'claim_refund_failure_alert', 'release_refund_failure_alert', 'append_camp_payment'];
  function deliver(event, stripe) {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_ted').update(`${t}.${body}`).digest('hex');
    const env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_WEBHOOK_SECRET: 'whsec_ted', RESEND_API_KEY: 're_test' };
    const scen = `
T.env = ${JSON.stringify(env)};
T.tables.camps = [{ id: '${C}', owner: '${OWNER}', payment_processor_key: 'stripe' }];
${bridge(db, RPCS, [])}
T.rpc.record_chargeback = (a: any) => {
  const L = (v: any) => v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
  return JSON.parse((T as any).__q('SELECT public.record_chargeback(p_camp_id => ' + L(a.p_camp_id) + '::uuid, p_dispute_id => ' + L(a.p_dispute_id)
    + ', p_refs => ARRAY[' + (a.p_refs || []).map(L).join(',') + ']::text[], p_amount => ' + Number(a.p_amount) + ', p_reason => ' + L(a.p_reason) + ', p_status => ' + L(a.p_status) + ')::text'));
};
const ST: any = ${JSON.stringify(stripe || {})};
T.fetch = async (url: string) => { for (const k of Object.keys(ST)) if (url.includes(k)) return ST[k]; return { __status: 404, error: { message: 'No such object' } }; };
T.requests = [{ headers: { 'stripe-signature': 't=${t},v1=' + ${JSON.stringify(sig)} }, rawBody: ${JSON.stringify(body)} }];`;
    const r = runEdges(['stripe-webhook'], scen);
    return { status: r.responses[0].status, log: (r.logs || []).join(' | ').slice(0, 300) };
  }

  console.log(`SETUP: in session (${sessions[0].startDate} → ${sessions[0].endDate}); Avi "below $5 → add $20" (cus_avi); Bea weekly $25 on the Gold family's card (cus_gold); Cy weekly $25 (cus_cy, control); all wallets $0`);
  console.log(`  run today: ${cron()}`);
  console.log(`  wallets: Avi $${wallet(7)}, Bea $${wallet(8)}, Cy $${wallet(9)}`);

  console.log(`\nA1. Avi's parent disputes the $20 auto-reload charge (pi_reload1) with the bank`);
  const META = { campId: C, source: 'campistry-canteen-deposit', camperId: '7', camperName: 'Avi', auto: 'true' };
  const stA = { '/payment_intents/pi_reload1': { id: 'pi_reload1', metadata: META }, '/charges/ch_reload1': { id: 'ch_reload1', payment_intent: 'pi_reload1', metadata: META } };
  const d1 = deliver({ id: 'evt_da1', type: 'charge.dispute.created', created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'dp_avi', object: 'dispute', amount: 2000, charge: 'ch_reload1', payment_intent: 'pi_reload1', reason: 'unrecognized', status: 'needs_response', metadata: {} } } }, stA);
  console.log(`  webhook HTTP ${d1.status}; Avi's wallet now $${wallet(7)}`);
  console.log(`  next day's run (${iso(now + DAY)}): ${cron(now + DAY)}`);
  console.log(`  cus_avi charged: ${charges('cus_avi')}`);
  check(charges('cus_avi').split(',').length === 1, 'A1 the card whose auto-reload charge is being disputed is not charged again while the bank decides', charges('cus_avi'));

  console.log(`\nA2. The Gold family (Bea) pays $1,000 tuition by card and disputes it`);
  const stG = { '/payment_intents/pi_gold': { id: 'pi_gold', metadata: { campId: C, familyKey: 'gold' } }, '/charges/ch_gold': { id: 'ch_gold', payment_intent: 'pi_gold', metadata: { campId: C, familyKey: 'gold' } } };
  deliver({ id: 'evt_pg', type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'pi_gold', object: 'payment_intent', amount: 100000, amount_received: 100000, status: 'succeeded', payment_method_types: ['card'], metadata: { campId: C, familyKey: 'gold', familyName: 'Gold' } } } }, stG);
  const d2 = deliver({ id: 'evt_dg', type: 'charge.dispute.created', created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'dp_gold', object: 'dispute', amount: 100000, charge: 'ch_gold', payment_intent: 'pi_gold', reason: 'fraudulent', status: 'needs_response', metadata: {} } } }, stG);
  const hold = q(`SELECT COALESCE((public.camp_family('${C}','gold')->'disputeHold')::text,'none')`);
  const notice = q(`SELECT body FROM notifications WHERE camp_id='${C}' AND source='autopay_blocked' LIMIT 1`);
  console.log(`  webhook HTTP ${d2.status}; Gold pause ${hold}`);
  console.log(`  the office's notice: "${notice}"`);
  console.log(`  a week later (${iso(now + 7 * DAY)}): ${cron(now + 7 * DAY)}`);
  console.log(`  cus_gold charged: ${charges('cus_gold')}; control cus_cy: ${charges('cus_cy')}`);
  check(charges('cus_gold').split(',').length === 1, 'A2 the paused family\'s card is not charged by canteen auto-reload during the dispute', charges('cus_gold'));
  check(charges('cus_cy').split(',').length === 2, 'A0 control Cy charged both weeks', charges('cus_cy'));
} catch (e) {
  check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 4).join(' | '));
} finally {
  db.stop();
  console.log(`\n${bad} BAD`);
}
