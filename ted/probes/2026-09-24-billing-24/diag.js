'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5848 });
const OWNER = '0ed23b00-0000-0000-0000-0000000000a1';
const C = '0ed23b00-0000-0000-0000-000000000001';
const q = (s) => db.sql(s).trim();
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const DAY = 86400000, iso = (ms) => new Date(ms).toISOString().slice(0, 10), now = Date.now();
try {
  q(`CREATE TABLE ted_sales (id serial, token text, cents int, day text);
     INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@d');
     INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','Sola Camp','cardknox');
     INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 11, 'camper', 'Eli', 'Eli');
     SELECT public.canteen_account_save('${C}', 'Eli', '{"balance": 0, "camperId": 11}'::jsonb);`);
  q(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${C}','Eli');
     PERFORM public.canteen_account_save('${C}','Eli', a || jsonb_build_object('camperId', 11, 'autoReload', ${lit({ enabled: true, cardOnFile: true, byopCustomerRef: 'tok_eli',
       thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 })})); END $x$;`);
  const sessions = [{ id: 's1', name: 'Summer', startDate: iso(now - 20 * DAY), endDate: iso(now + 30 * DAY), dates: '', tuition: 1000, capacity: 100 }];
  q(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', ${lit({ families: {}, enrollments: {}, sessions, sessionBundles: [], enrollSettings: {} })}),
       ('${C}', 'campDates', ${lit({ startDate: sessions[0].startDate, endDate: sessions[0].endDate })});`);
  const scen = `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'cron_s' };
${bridge(db, ['update_canteen_autoreload_state', 'claim_refund_intent', 'release_refund_intent', 'camp_families_object', 'credit_canteen_balance_from_processor', 'camp_family_key_for_person'], ['camp_state_kv'])}
T.rpc.canteen_autoreload_accounts = (a: any) => JSON.parse((T as any).__q("SELECT coalesce(json_agg(x), '[]'::json)::text FROM public.canteen_autoreload_accounts() x WHERE x.camp_id = '${C}'") || '[]');
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck_key' } });
T.tables.camps = [{ id: '${C}', owner: 'u-owner', payment_processor_key: 'cardknox', name: 'Sola Camp' }];
const __qq = (T as any).__q;
T.fetch = async (url: string, init: any) => {
  if (url.includes('cardknox')) {
    const p = new URLSearchParams(String(init.body || ''));
    const r = JSON.parse(__qq("INSERT INTO ted_sales (token, cents, day) VALUES ('" + p.get('xToken') + "'," + Math.round(Number(p.get('xAmount')) * 100) + ",'" + new Date().toISOString().slice(0, 10) + "') RETURNING row_to_json(ted_sales)::text"));
    return 'xResult=A&xStatus=Approved&xRefNum=' + (7000 + r.id);
  }
  return {};
};
T.requests = [{ headers: { 'x-cron-secret': 'cron_s' }, body: {} }];`;
  const r = runEdges(['canteen-auto-reload'], scen);
  console.log('cron result:', JSON.stringify(r.responses[0].body).slice(0, 300));
  console.log('\ncanteen_transactions payloads:');
  console.log(q(`SELECT tx_type || ' | ' || coalesce(payload->>'kind','-') || ' | byop=' || coalesce(payload->>'byopTransactionId','(none)') || ' | stripe=' || coalesce(payload->>'stripePaymentIntentId','(none)') || ' | ' || coalesce(payload::text,'') FROM canteen_transactions WHERE camp_id='${C}'`));
  console.log('\ncanteen_dispute_family(7001):', q(`SELECT public.canteen_dispute_family('${C}','7001')::text`));
  console.log('_canteen_deposit_of(7001) camper:', q(`SELECT coalesce((public._canteen_deposit_of('${C}','7001')).camper,'(null)')`));
} catch (e) { console.log('ERR', String(e.stack||e).split('\n').slice(0,6).join('\n')); }
finally { db.stop(); }
