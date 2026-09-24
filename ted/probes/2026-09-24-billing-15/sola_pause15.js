// Probe (15th pass, TED-143 claim 2, the Sola side — the builder's tests cover
// only the two Stripe functions). The REAL payments-canteen-refund-all and
// payments-canteen-refund on the REAL migration chain (the pause is written
// through the real update_canteen_autoreload_state), a pretend Sola gateway
// that approves every cc:refund. Avi: $50 put on by card through Sola, and his
// parent's auto-reload on ("below $5 → add $20", card token on file).
//   P1 Refund All (Sola) → wallet $0: is auto-reload switched off, the rest kept?
//   P2 (fresh) the child's own Refund for all $50: the same?
//   P3 (fresh) the child's own Refund for $20 of the $50: auto-reload stays on?
//   P4 then the REAL canteen-auto-reload run (cron) after P1: is the parent charged?
//   P5 control: a $0 Sola wallet with auto-reload still on IS charged by the same run
// Run: node ted/probes/2026-09-24-billing-15/sola_pause15.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5691 });
const q1 = (s) => db.sql(s).trim();
const OWNER = '0ed15000-0000-0000-0000-0000000000f1';
const RPCS = ['canteen_refund_view', 'reserve_canteen_refund', 'settle_canteen_refund_hold', 'release_canteen_refund_hold',
  'claim_refund_intent', 'settle_refund_intent', 'release_refund_intent', 'release_stale_refund_intent', 'record_processor_transaction',
  'update_canteen_autoreload_state', 'canteen_autoreload_accounts', 'claim_refund_intent'];
const BR = bridge(db, RPCS, ['refund_intents', 'camp_state_kv']);
let n = 0, bad = 0;
db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@ted15f');`);
const AR = { enabled: true, cardOnFile: true, processor: 'cardknox', byopCustomerRef: 'tok_avi', paymentMethodLabel: 'Visa ···· 4242',
  thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 };
function camp() {
  n++;
  const C = `0ed15000-0000-0000-0000-${String(200 + n).padStart(12, '0')}`;
  db.sql(`INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','S${n}','cardknox');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 7, 'camper', 'Avi', 'Avi');
    SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 0}'::jsonb);
    SELECT public.canteen_post('${C}', 'Avi', '{"type":"credit","kind":"deposit","method":"cardknox","byopTransactionId":"X${n}","amount":50,"date":"2026-07-01","timestamp":1,"camperId":7}'::jsonb);
    SELECT public.canteen_account_save('${C}', 'Avi', '${JSON.stringify({ balance: 50, camperId: 7, autoReload: AR })}'::jsonb);`);
  return C;
}
const scen = (C, req) => `T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'cron_s' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: '${C}', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck', sourceKey: 'sk', pin: 'p' } });
${BR}
T.rpc.canteen_autoreload_accounts = (a: any) => JSON.parse((T as any).__q("SELECT coalesce(json_agg(x), '[]'::json)::text FROM public.canteen_autoreload_accounts() x WHERE x.camp_id = '${C}'") || '[]');
let k = 0; T.tables.__money = [];
T.fetch = (url: string, init: any) => {
  const b = String(init.body || '');
  if (b.includes('cc%3Arefund')) { k++; const p = new URLSearchParams(b); T.tables.__money.push('refund ' + p.get('xRefNum') + ' $' + p.get('xAmount')); return 'xResult=A&xRefNum=RF' + k + '&xStatus=Approved'; }
  if (b.includes('cc%3Asale')) { k++; const p = new URLSearchParams(b); T.tables.__money.push('SALE $' + p.get('xAmount') + ' on ' + p.get('xToken')); return 'xResult=A&xRefNum=SA' + k + '&xStatus=Approved'; }
  return {};
};
T.requests = [${req}];`;
const ar = (C) => JSON.parse(q1(`SELECT (payload->'autoReload')::text FROM camp_canteen_accounts WHERE camp_id='${C}' AND account_key='Avi'`));
const wallet = (C) => Number(q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND account_key='Avi'`));
const say = (a) => `enabled ${a.enabled}; reason "${a.disabledReason || ''}"; card still on file ${a.cardOnFile} (${a.byopCustomerRef}); trigger "$${a.thresholdReloadAmount} below $${a.thresholdAmount}"`;
try {
  let C = camp();
  let r = runEdges(['payments-canteen-refund-all'], scen(C, `{ headers: { Authorization: 'Bearer owner' }, body: {} }`));
  console.log(`P1 Refund All (Sola): $${r.responses[0].body.totalRefunded}; sent ${JSON.stringify(r.tables.__money)}; wallet $${wallet(C)}\n   auto-reload: ${say(ar(C))}`);
  if (ar(C).enabled !== false || ar(C).byopCustomerRef !== 'tok_avi') bad++;
  const c1 = C;
  C = camp();
  r = runEdges(['payments-canteen-refund'], scen(C, `{ headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 50, idempotencyKey: 'cref_p2' } }`));
  console.log(`P2 the child's Refund, all $50: $${r.responses[0].body.totalRefunded}; wallet $${wallet(C)}\n   auto-reload: ${say(ar(C))}`);
  if (ar(C).enabled !== false) bad++;
  C = camp();
  r = runEdges(['payments-canteen-refund'], scen(C, `{ headers: { Authorization: 'Bearer owner' }, body: { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_p3' } }`));
  console.log(`P3 the child's Refund, $20 of $50: $${r.responses[0].body.totalRefunded}; wallet $${wallet(C)}\n   auto-reload: ${say(ar(C))}`);
  if (ar(C).enabled !== true) bad++;
  r = runEdges(['canteen-auto-reload'], scen(c1, `{ headers: { 'x-cron-secret': 'cron_s' }, body: {} }`));
  console.log(`P4 the auto-reload run after P1: ${JSON.stringify(r.responses[0].body).slice(0, 160)}; money moved ${JSON.stringify(r.tables.__money)}`);
  if (r.tables.__money.some((m) => /SALE/.test(m))) bad++;
  C = camp();
  db.sql(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${C}','Avi'); PERFORM public.canteen_account_save('${C}','Avi', a || '{"balance": 0}'::jsonb); END $x$;`);
  r = runEdges(['canteen-auto-reload'], scen(C, `{ headers: { 'x-cron-secret': 'cron_s' }, body: {} }`));
  console.log(`P5 control: a Sola wallet at $0 with auto-reload still on → run: ${JSON.stringify(r.responses[0].body).slice(0, 160)}; money moved ${JSON.stringify(r.tables.__money)}`);
  if (!r.tables.__money.some((m) => /SALE/.test(m))) { bad++; console.log('  (the control did not charge — P4 proves nothing)'); }
} catch (e) { console.log('ERROR ' + String(e.stack || e.message).slice(0, 800)); bad++; }
finally { db.stop(); }
console.log(`\n${bad} BAD`);
