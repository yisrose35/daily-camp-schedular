// Probe (14th pass, TED-142 re-check, the Sola side). Avi: $50 put on by card
// through Sola, parent's Balance Floor $10, spent nothing. The REAL
// payments-canteen-refund-all and payments-canteen-refund on the REAL migration
// chain (275's reserve_canteen_refund caps the refund), a pretend Sola gateway
// that approves every cc:refund.
//   S1 Refund All (Sola)          S2 (fresh) the child's own Refund for $50
//   S3 (fresh) what the Sola Refund window is told
// Run: node ted/probes/2026-09-24-billing-14/floor_sola_realdb.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5667 });
const q1 = (s) => db.sql(s).trim();
const OWNER = '0ed14000-0000-0000-0000-0000000000a1';
const RPCS = ['canteen_refund_view', 'reserve_canteen_refund', 'settle_canteen_refund_hold', 'release_canteen_refund_hold',
  'claim_refund_intent', 'settle_refund_intent', 'release_refund_intent', 'release_stale_refund_intent', 'record_processor_transaction'];
const BR = bridge(db, RPCS, ['refund_intents']);
let n = 0, bad = 0;
db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@ted14');`);
function camp() {
  n++;
  const C = `0ed14000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  db.sql(`INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','S${n}','cardknox');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 7, 'camper', 'Avi', 'Avi');
    SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 0}'::jsonb);
    SELECT public.canteen_post('${C}', 'Avi', '{"type":"credit","kind":"deposit","method":"cardknox","byopTransactionId":"X${n}","amount":50,"date":"2026-07-01","timestamp":1,"camperId":7}'::jsonb);
    SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 50, "balanceFloor": 10}'::jsonb);`);
  return C;
}
const scen = (C, body) => `T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner' };
T.tables.camps = [{ id: '${C}', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
${BR}
let k = 0; T.tables.__money = [];
T.fetch = (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) { k++; const p = new URLSearchParams(init.body); T.tables.__money.push(p.get('xRefNum') + ' $' + p.get('xAmount')); return 'xResult=A&xRefNum=RF' + k + '&xStatus=Approved'; }
  return {};
};
T.requests = [{ headers: { Authorization: 'Bearer owner' }, body: ${JSON.stringify(body)} }];`;
const wallet = (C) => Number(q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND account_key='Avi'`));
try {
  let C = camp();
  let r = runEdges(['payments-canteen-refund-all'], scen(C, {}));
  console.log(`S1 Refund All (Sola): ${JSON.stringify(r.responses[0].body).slice(0, 200)}\n   sent to Sola: ${JSON.stringify(r.tables.__money)}; wallet $${wallet(C)}`);
  if (wallet(C) !== 0) bad++;
  C = camp();
  r = runEdges(['payments-canteen-refund'], scen(C, { camperId: 7, camperName: 'Avi', amount: 50, idempotencyKey: 'cref_s2' }));
  console.log(`S2 the child's Refund, $50: ${JSON.stringify(r.responses[0].body).slice(0, 200)}\n   sent to Sola: ${JSON.stringify(r.tables.__money)}; wallet $${wallet(C)}`);
  if (wallet(C) !== 0) bad++;
  C = camp();
  r = runEdges(['payments-canteen-refund'], scen(C, { action: 'holds' }));
  console.log(`S3 the Refund window is told: ${JSON.stringify(r.responses[0].body.refundable)}`);
  if (!(r.responses[0].body.refundable && r.responses[0].body.refundable.Avi && r.responses[0].body.refundable.Avi.now === 50)) bad++;
} catch (e) { console.log('ERROR ' + String(e.stack || e.message).slice(0, 800)); bad++; }
finally { db.stop(); }
console.log(`\n${bad} BAD`);
