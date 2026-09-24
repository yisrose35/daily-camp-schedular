// Probe (15th pass, TED-143 re-check). The REAL canteen-auto-reload (called the
// way the cron calls it, with the x-cron-secret) on the REAL migration chain,
// with a pretend Stripe that records every charge it is asked for.
//
// Two children whose wallets are $0 at the end of camp (they spent it all), so
// Refund All refunded nothing for them and switched nothing off:
//   Bea (#8): WEEKLY reload, "every <today's weekday>, add $25", no Active dates
//   Avi (#7): "below $5, add $20", no Active dates
//
//   D1 the camp's dates say the season ended yesterday → the run charges nobody?
//   D2 it is spring; the owner has entered NEXT summer's sessions (camp starts
//      in 90 days, ends in 150) → does the run charge now, months before camp?
//      and each week after?
//   D3 a camp with no session dates at all → does the run charge? (the Link
//      form now tells parents "the camp stops it after the season either way")
//   D4 the office's new switch (Snacks → Settings → Parents' auto-reload: Off)
//   D5 control: in season (ends in 30 days) → charges as before
// Run: node ted/probes/2026-09-24-billing-15/autoreload_dates15.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5671 });

const RPCS = ['canteen_autoreload_accounts', 'update_canteen_autoreload_state', 'claim_refund_intent', 'release_refund_intent'];
const BR = bridge(db, RPCS, ['camp_state_kv']);
const q1 = (s) => db.sql(s).trim();
const OWNER = '0ed15000-0000-0000-0000-0000000000a1';
db.sql(`CREATE TABLE ted_pis (id serial, camp text, customer text, cents int, credited boolean NOT NULL DEFAULT false, at timestamptz DEFAULT now());
  INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@ted15') ON CONFLICT DO NOTHING;`);

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86400000;
let campN = 0;
function camp() {
  campN++;
  const C = `0ed15000-0000-0000-0000-${String(campN).padStart(12, '0')}`;
  db.sql(`INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','D${campN}','stripe');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 7, 'camper', 'Avi', 'Avi'), ('${C}', 8, 'camper', 'Bea', 'Bea');
    SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 0, "camperId": 7}'::jsonb);
    SELECT public.canteen_account_save('${C}', 'Bea', '{"balance": 0, "camperId": 8}'::jsonb);`);
  const ar = (name, id, cfg) => db.sql(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${C}','${name}');
    PERFORM public.canteen_account_save('${C}','${name}', a || jsonb_build_object('camperId', ${id}, 'autoReload', '${JSON.stringify(cfg)}'::jsonb)); END $x$;`);
  ar('Avi', 7, { enabled: true, cardOnFile: true, stripeCustomerId: 'cus_avi', stripePaymentMethodId: 'pm_avi',
    thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 });
  return C;
}
function bea(C, dow) {
  db.sql(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${C}','Bea');
    PERFORM public.canteen_account_save('${C}','Bea', a || jsonb_build_object('autoReload', '${JSON.stringify({ enabled: true, cardOnFile: true,
      stripeCustomerId: 'cus_bea', stripePaymentMethodId: 'pm_bea', thresholdEnabled: false, scheduleEnabled: true, scheduleFrequency: 'weekly',
      scheduleDay: dow, scheduleReloadAmount: 25, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 })}'::jsonb)); END $x$;`);
}
const kv = (C, key, val) => db.sql(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', '${key}', '${JSON.stringify(val)}'::jsonb)
  ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value`);

const STRIPE = `
const __qq = (T as any).__q;
T.fetch = async (url: string, init: any) => {
  if (init.method === 'POST' && url.endsWith('/payment_intents')) {
    const p = new URLSearchParams(String(init.body || ''));
    const r = JSON.parse(__qq("INSERT INTO ted_pis (camp, customer, cents) VALUES ('" + String(p.get('metadata[campId]')) + "','" + String(p.get('customer')) + "'," + Number(p.get('amount')) + ") RETURNING row_to_json(ted_pis)::text"));
    return { id: 'pi_reload' + r.id, object: 'payment_intent', amount: r.cents, amount_received: r.cents, status: 'succeeded', customer: r.customer };
  }
  return {};
};`;
function cron(C, ts) {
  const scen = `
T.env = { STRIPE_SECRET_KEY: 'sk_test', SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'cron_s' };
${BR}
T.rpc.canteen_autoreload_accounts = (a: any) => JSON.parse((T as any).__q("SELECT coalesce(json_agg(x), '[]'::json)::text FROM public.canteen_autoreload_accounts("
  + (a && a.p_camp_id ? "p_camp_id => '" + String(a.p_camp_id) + "'::uuid" : '') + ") x WHERE x.camp_id = '${C}'") || '[]');
T.tables.camps = [{ id: '${C}', owner: 'u-owner', payment_processor_key: 'stripe', stripe_account_id: null, stripe_charges_enabled: false, name: 'D' }];
${STRIPE}
${ts ? `const __RealDate = Date; (globalThis as any).Date = class extends __RealDate { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(${ts}); } static now() { return ${ts}; } };` : ''}
T.requests = [{ headers: { 'x-cron-secret': 'cron_s' }, body: {} }];`;
  const r = runEdges(['canteen-auto-reload'], scen);
  const b = r.responses[0].body || {};
  // Stripe confirms each charge; the money lands on the child's wallet (the webhook's own writer, real SQL)
  for (const row of JSON.parse(q1(`SELECT coalesce(json_agg(p), '[]'::json)::text FROM ted_pis p WHERE camp='${C}' AND NOT credited`))) {
    const who = row.customer === 'cus_bea' ? [8, 'Bea'] : [7, 'Avi'];
    db.sql(`SELECT public.credit_canteen_balance_from_stripe(p_camp_id => '${C}', p_camper_id => ${who[0]}, p_camper_name => '${who[1]}', p_amount => ${row.cents / 100}, p_payment_intent_id => 'pi_reload${row.id}'); UPDATE ted_pis SET credited = true WHERE id = ${row.id};`);
  }
  return (b.details || []).map((d) => d.camper ? `${d.camper} ${d.kind || ''} $${d.amount} → ${d.result}` : `camp → ${d.result}`).join('; ') || JSON.stringify(b).slice(0, 140);
}
const charged = (C) => q1(`SELECT coalesce(string_agg('$' || (cents/100) || ' from ' || customer, ', ' ORDER BY id), 'none') FROM ted_pis WHERE camp='${C}'`);
const nCharged = (C) => Number(q1(`SELECT count(*) FROM ted_pis WHERE camp='${C}'`));
let bad = 0;
const verdict = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
const now = Date.now();
const dow = new Date(now).getUTCDay();

try {
  console.log(`SETUP (each case its own camp): Avi (#7) "below $5 → add $20", Bea (#8) weekly on today's weekday → add $25; both wallets $0, no Active dates; today ${iso(now)}\n`);

  { const C = camp(); bea(C, dow);
    kv(C, 'campDates', { startDate: iso(now - 60 * DAY), endDate: iso(now - DAY) });
    console.log(`D1. campDates ${iso(now - 60 * DAY)} → ${iso(now - DAY)} (the season ended yesterday)`);
    console.log(`    run: ${cron(C)}`);
    verdict(nCharged(C) === 0, 'D1 after the season ends, nobody is charged', charged(C)); }

  { const C = camp(); bea(C, dow);
    kv(C, 'campDates', { startDate: iso(now + 90 * DAY), endDate: iso(now + 150 * DAY) });
    console.log(`\nD2. Spring: the owner has entered NEXT summer's sessions → campDates ${iso(now + 90 * DAY)} → ${iso(now + 150 * DAY)}`);
    console.log(`    run today (${iso(now)}): ${cron(C)}`);
    for (const w of [1, 2, 3]) console.log(`    run week ${w + 1} (${iso(now + 7 * w * DAY)}): ${cron(C, now + 7 * w * DAY) || '—'}`);
    verdict(nCharged(C) === 0, 'D2 months before camp starts, nobody is charged', `${nCharged(C)} charge(s): ${charged(C)}; wallets Avi $${q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND account_key='Avi'`)}, Bea $${q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND account_key='Bea'`)}`); }

  { const C = camp(); bea(C, dow);
    console.log(`\nD3. A camp with no session dates at all (no campDates row)`);
    console.log(`    run: ${cron(C)}`);
    console.log(`    (the Link form now says: "Auto-reload only charges within this window — and the camp stops it after the season either way.")`);
    console.log(`  NOTE D3 no dates → charged as before (the builder's stated behaviour): ${charged(C)}`); }

  { const C = camp(); bea(C, dow);
    kv(C, 'campDates', { startDate: iso(now - 30 * DAY), endDate: iso(now + 30 * DAY) });
    kv(C, 'campistrySnacks', { settings: { cashDailyMax: 20, autoReloadOff: true } });
    console.log(`\nD4. In season, but the office switched Parents' auto-reload Off (Snacks → Settings)`);
    console.log(`    run: ${cron(C)}`);
    verdict(nCharged(C) === 0, 'D4 the office\'s switch stops every charge', charged(C)); }

  { const C = camp(); bea(C, dow);
    kv(C, 'campDates', { startDate: iso(now - 30 * DAY), endDate: iso(now + 30 * DAY) });
    console.log(`\nD5. Control: in season (ends ${iso(now + 30 * DAY)})`);
    console.log(`    run: ${cron(C)}`);
    verdict(nCharged(C) === 2, 'D5 in season it still tops up (Avi $20 + Bea $25)', charged(C)); }
} catch (e) { console.log('ERROR', String(e.stack || e.message).slice(0, 2000)); bad++; }
finally { db.stop && db.stop(); }
console.log(`\n${bad} BAD`);
