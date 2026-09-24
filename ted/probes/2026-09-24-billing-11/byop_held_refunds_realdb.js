// Probe (11th pass, TED-116 server half). payments-canteen-refund(-all), the
// REAL functions against the REAL migration chain (275 holds, 198/273 claims)
// on a scratch Postgres, with a pretend Cardknox (Sola) remembered in the DB.
//   H1 Refund All refunds Avi $20, Sola made it, the answer is lost. The office
//      lists the waiting refunds and answers "it went through" with Sola's ref.
//   H2 A single $20 refund (of $50) never reached Sola; the office reloads
//      Snacks and refunds $20 again; the server asks; the office confirms
//      "not there" (what the page sends: confirmNotRefunded + confirmHolds).
//   H3 "Nothing went through" answered 1 minute after sending, then 5 minutes.
//   H4 "It went through" with a reference already on another refund.
//   H5 The same actions from a scheduler (not owner/admin) and a stranger.
// Run: node ted/probes/2026-09-24-billing-11/byop_held_refunds_realdb.js
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5614 });
const RPCS = ['canteen_refund_view', 'reserve_canteen_refund', 'settle_canteen_refund_hold', 'release_canteen_refund_hold',
  'claim_refund_intent', 'settle_refund_intent', 'release_refund_intent', 'release_stale_refund_intent', 'record_processor_transaction'];
const BR = bridge(db, RPCS, ['refund_intents']);
const q1 = (s) => db.sql(s).trim();
let n = 0;
db.sql(`CREATE TABLE ted_charge (ref text PRIMARY KEY, amount int, refunded int NOT NULL DEFAULT 0);
  CREATE TABLE ted_money (id serial, camp text, ref text, cents int);
  CREATE TABLE ted_flags (k text PRIMARY KEY, n int);
  INSERT INTO auth.users (id, email) VALUES ('0ed14000-0000-0000-0000-0000000000a1','o@ted') ON CONFLICT DO NOTHING;`);
function camp(topup, spent) {
  n++;
  const C = `0ed14000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const ref = 'X' + n + 'top';
  db.sql(`INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','0ed14000-0000-0000-0000-0000000000a1','P${n}','cardknox');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 7, 'camper', 'Avi', 'Avi');
    SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": 0}'::jsonb);
    SELECT public.canteen_post('${C}', 'Avi', '{"type":"credit","kind":"deposit","method":"cardknox","byopTransactionId":"${ref}","amount":${topup},"date":"2026-07-01","timestamp":1}'::jsonb);
    ${spent ? `SELECT public.canteen_post('${C}', 'Avi', '{"type":"debit","kind":"purchase","amount":${spent},"date":"2026-07-02","timestamp":2}'::jsonb);` : ''}
    SELECT public.canteen_account_save('${C}', 'Avi', '{"balance": ${topup - spent}, "balanceFloor": 0}'::jsonb);
    INSERT INTO ted_charge (ref, amount) VALUES ('${ref}', ${topup * 100});`);
  return { C, ref };
}
const SOLA = `
const __qq = (T as any).__q;
const __flag = (k: string) => { const n = Number(__qq("SELECT coalesce((SELECT n FROM ted_flags WHERE k='" + k + "'),0)")); if (n > 0) { __qq("UPDATE ted_flags SET n = n - 1 WHERE k='" + k + "'"); return true; } return false; };
T.fetch = async (url: string, init: any) => {
  if (String(init.body || '').includes('cc%3Arefund')) {
    if (__flag('lose_before')) throw new Error('connection reset (never reached)');
    const p = new URLSearchParams(init.body);
    const ref = String(p.get('xRefNum')); const cents = Math.round(Number(p.get('xAmount')) * 100);
    const row = JSON.parse(__qq("SELECT row_to_json(c)::text FROM ted_charge c WHERE ref='" + ref + "'") || 'null');
    if (!row || row.amount - row.refunded < cents) return 'xResult=E&xStatus=Error&xError=Amount%20exceeds';
    const id = __qq("INSERT INTO ted_money (camp, ref, cents) VALUES ('" + T.__camp + "','" + ref + "'," + cents + ") RETURNING 'RN' || id");
    __qq("UPDATE ted_charge SET refunded = refunded + " + cents + " WHERE ref='" + ref + "'");
    if (__flag('lose')) throw new Error('connection reset');
    return 'xResult=A&xStatus=Approved&xRefNum=' + id;
  }
  return {};
};`;
function scenario(c, who, body) {
  return `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
T.users = { owner: 'u-owner', sched: 'u-sched', stranger: 'u-stranger' };
T.tables.camps = [{ id: '${c.C}', owner: 'u-owner', payment_processor_key: 'cardknox' }];
T.tables.camp_users = [{ camp_id: '${c.C}', user_id: 'u-sched', role: 'scheduler', accepted_at: '2026-01-01' }];
T.__camp = '${c.C}';
T.rpc._admin_get_processor_credential = () => ({ success: true, credentials: { apiKey: 'ck' } });
${BR}
${SOLA}
T.requests = [{ headers: { Authorization: 'Bearer ${who}' }, body: ${JSON.stringify(body)} }];`;
}
const call = (fn, c, body, who = 'owner') => { const r = runEdges([fn], scenario(c, who, body)).responses[0]; return { status: r.status, body: r.body }; };
const ONE = 'payments-canteen-refund', ALL = 'payments-canteen-refund-all';
const flag = (k, v = 1) => db.sql(`INSERT INTO ted_flags VALUES ('${k}', ${v}) ON CONFLICT (k) DO UPDATE SET n = ${v}`);
const clear = () => db.sql('DELETE FROM ted_flags');
const age = (c, i) => db.sql(`UPDATE canteen_refund_holds SET created_at = created_at - interval '${i}' WHERE camp_id='${c.C}'; UPDATE refund_intents SET created_at = created_at - interval '${i}', called_at = called_at - interval '${i}' WHERE camp_id='${c.C}'`);
const st = (c) => `money back $${q1(`SELECT coalesce(sum(cents),0)/100.0 FROM ted_money WHERE camp='${c.C}'`)} [${q1(`SELECT coalesce(string_agg('RN' || id, ','), '') FROM ted_money WHERE camp='${c.C}'`)}], wallet $${q1(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${c.C}' AND account_key='Avi'`)}, holds [${q1(`SELECT coalesce(string_agg(state || ' $' || amount, ', ' ORDER BY created_at), 'none') FROM canteen_refund_holds WHERE camp_id='${c.C}'`)}], history [${q1(`SELECT coalesce(string_agg(payload->>'byopRefundId' || ' $' || amount, ', '), 'none') FROM canteen_transactions WHERE camp_id='${c.C}' AND payload->>'kind'='refund'`)}]`;
const j = (x) => x.status + ' ' + JSON.stringify(x.body).slice(0, 170);
try {
  console.log('H1 Refund All, Sola made it, answer lost; the office answers "it went through"');
  { const c = camp(50, 30); clear(); flag('lose');
    console.log('  Refund All →', j(call(ALL, c, {}))); age(c, '10 minutes');
    const list = call(ONE, c, { action: 'holds' }); console.log('  holds →', j(list));
    const key = list.body.holds[0].key; const realRef = q1(`SELECT 'RN' || id FROM ted_money WHERE camp='${c.C}'`);
    console.log('  it went through, ref ' + realRef + ' →', j(call(ONE, c, { action: 'resolveHold', holdKey: key, wentThrough: true, reference: realRef })));
    console.log('  the same answer again (2nd tab) →', j(call(ONE, c, { action: 'resolveHold', holdKey: key, wentThrough: true, reference: realRef })));
    console.log('  Refund All again →', j(call(ALL, c, {})));
    console.log('  ' + st(c) + '   (want money $20 once, wallet $0, RN on the history, hold posted)'); }

  console.log('H2 single $20 of $50 never reached Sola; reload; $20 again; server asks; office confirms "not there"');
  { const c = camp(50, 0); clear(); flag('lose_before');
    console.log('  press 1 →', j(call(ONE, c, { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_h2a' }))); clear(); age(c, '10 minutes');
    const a = call(ONE, c, { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_h2b' }); console.log('  after reload →', j(a));
    const b = call(ONE, c, { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_h2b', confirmNotRefunded: true, confirmHolds: a.body.confirmHolds });
    console.log('  confirmed →', j(b));
    console.log('  ' + st(c) + '   (want money $20 once, wallet $30)'); }

  console.log('H3 "nothing went through" 1 minute after sending, then after 5 minutes');
  { const c = camp(50, 0); clear(); flag('lose_before');
    call(ONE, c, { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_h3' }); clear(); age(c, '1 minute');
    const key = call(ONE, c, { action: 'holds' }).body.holds[0].key;
    console.log('  at 1 min →', j(call(ONE, c, { action: 'resolveHold', holdKey: key, wentThrough: false })));
    age(c, '4 minutes');
    console.log('  at 5 min →', j(call(ONE, c, { action: 'resolveHold', holdKey: key, wentThrough: false })));
    console.log('  the office then refunds $20 again (same page key) →', j(call(ONE, c, { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_h3' })));
    console.log('  ' + st(c) + '   (want money $20 once, wallet $30)'); }

  console.log('H4 "it went through" with a reference already on another refund');
  { const c = camp(50, 0); clear();
    call(ONE, c, { camperId: 7, camperName: 'Avi', amount: 10, idempotencyKey: 'cref_h4a' });     // a real $10 refund, RN on the history
    const used = q1(`SELECT 'RN' || id FROM ted_money WHERE camp='${c.C}'`);
    flag('lose_before'); call(ONE, c, { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_h4b' }); clear(); age(c, '10 minutes');
    const key = call(ONE, c, { action: 'holds' }).body.holds[0].key;
    console.log('  reference ' + used + ' (already used) →', j(call(ONE, c, { action: 'resolveHold', holdKey: key, wentThrough: true, reference: used })));
    console.log('  ' + st(c)); }

  console.log('H5 who may use the new actions');
  { const c = camp(50, 0); clear(); flag('lose_before'); call(ONE, c, { camperId: 7, camperName: 'Avi', amount: 20, idempotencyKey: 'cref_h5' }); clear(); age(c, '10 minutes');
    const key = q1(`SELECT hold_key FROM canteen_refund_holds WHERE camp_id='${c.C}'`);
    for (const who of ['sched', 'stranger']) {
      console.log(`  ${who}: holds →`, j(call(ONE, c, { action: 'holds' }, who)), '| resolveHold →', j(call(ONE, c, { action: 'resolveHold', holdKey: key, wentThrough: false }, who)));
    }
    console.log('  ' + st(c) + '   (want hold still open, wallet $30)'); }
} catch (e) { console.log('ERROR', String(e.stack || e.message).slice(0, 1500)); }
finally { db.stop && db.stop(); }
