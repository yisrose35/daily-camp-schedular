// Probe (23rd pass, byop23). The REAL byop-dispute-webhook and the REAL
// canteen-auto-reload at 1b0067b, on the REAL migration chain (incl. 288 as
// edited and 290), with a pretend Cardknox gateway that records every sale.
//   K0  set up as the guides now say (secret set; sent as &key= on the URL)
//       → accepted; wrong key → 401; no key → 401
//   K1  Birch paid $500 by Cardknox (ref 9001). Cardknox posts an ordinary
//       TRANSACTION notification for it (xStatus Approved, xCommand cc:sale) to
//       the dispute URL — BYOP_SETUP.md itself says that screen looks like the
//       transaction postback. Is a chargeback posted? Is Birch paused?
//   K2  Eli (Cardknox camp) auto-reload charges his parent's saved card $20
//       (ref 7001). The parent disputes it; Cardknox posts it (xStatus
//       Chargeback). Does the wallet lose the $20? Is auto-reload paused? Next
//       day: is the same card charged again?
//   K3  DB error while posting (TED-206 claim) → 500; payment_not_found → 200
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5833 });
const OWNER = '0ed23b00-0000-0000-0000-0000000000a1';
const C = '0ed23b00-0000-0000-0000-000000000001';
const q = (s) => db.sql(s).trim();
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const now = Date.now();
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
try {
  q(`CREATE TABLE ted_sales (id serial, token text, cents int, day text);
     INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t23b');
     INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','Sola Camp','cardknox');
     INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${C}', 11, 'camper', 'Eli', 'Eli'), ('${C}', 12, 'camper', 'Birch Kid', 'Birch Kid');
     SELECT public.canteen_account_save('${C}', 'Eli', '{"balance": 0, "camperId": 11}'::jsonb);`);
  q(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${C}','Eli');
     PERFORM public.canteen_account_save('${C}','Eli', a || jsonb_build_object('camperId', 11, 'autoReload', ${lit({ enabled: true, cardOnFile: true, byopCustomerRef: 'tok_eli',
       thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 })})); END $x$;`);
  const sessions = [{ id: 's1', name: 'Summer', startDate: iso(now - 20 * DAY), endDate: iso(now + 30 * DAY), dates: '', tuition: 1000, capacity: 100 }];
  const fams = {
    birch: { name: 'Birch', camperIds: ['Birch Kid'], byopCustomerRef: 'tok_birch', cardOnFile: true,
      entries: [{ id: 'c_birch', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-01' },
                { id: 'pay_birch', kind: 'payment', amount: 500, method: 'card', date: '2026-06-01', source: { paymentId: '9001', processor: 'cardknox' } }] },
    elif: { name: 'Eli family', camperIds: ['Eli'], byopCustomerRef: 'tok_eli', cardOnFile: true, entries: [] },
  };
  q(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', ${lit({ families: fams, enrollments: {}, sessions, sessionBundles: [], enrollSettings: {} })}),
       ('${C}', 'campDates', ${lit({ startDate: sessions[0].startDate, endDate: sessions[0].endDate })});
     SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);
     SELECT public.sync_camp_billing('${C}', ${lit(fams)}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);`);
  const fam = (k) => JSON.parse(q(`SELECT public.camp_family('${C}','${k}')::text`));
  const owes = (k) => { const f = fam(k); return (f.entries || []).reduce((t, e) => t + (e.kind === 'charge' ? +e.amount : e.kind === 'payment' ? -e.amount : e.kind === 'refund' ? +e.amount : 0), 0); };
  const wallet = () => q(`SELECT balance FROM camp_canteen_accounts WHERE camp_id='${C}' AND person_id=11`);
  const arState = () => q(`SELECT (a->'autoReload'->>'enabled') || ' / ' || coalesce(a->'autoReload'->>'disabledReason','-') FROM (SELECT public.canteen_account_lock('${C}','Eli') a) x`);
  const sales = (tok) => q(`SELECT coalesce(string_agg(day || ' $' || (cents/100), ', ' ORDER BY id), 'none') FROM ted_sales WHERE token='${tok}'`);

  function byop(body, urlExtra, headers, over) {
    const scen = `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', BYOP_DISPUTE_SECRET: 'sek_long_value' };
${bridge(db, ['resolve_chargeback', 'hold_autopay_for_dispute', 'note_dispute_lost', 'camp_families_object'], [])}
T.rpc.record_chargeback = (a: any) => {
  const L = (v: any) => v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
  return JSON.parse((T as any).__q('SELECT public.record_chargeback(p_camp_id => ' + L(a.p_camp_id) + '::uuid, p_dispute_id => ' + L(a.p_dispute_id)
    + ', p_refs => ARRAY[' + (a.p_refs || []).map(L).join(',') + ']::text[], p_amount => ' + (a.p_amount == null ? 'NULL' : Number(a.p_amount)) + ', p_reason => ' + L(a.p_reason) + ', p_status => ' + L(a.p_status) + ')::text'));
};
${over || ''}
T.requests = [{ url: 'http://edge.test/byop-dispute-webhook?processor=cardknox&camp=${C}${urlExtra}', headers: ${JSON.stringify(headers || {})}, rawBody: ${JSON.stringify(JSON.stringify(body))} }];`;
    const r = runEdges(['byop-dispute-webhook'], scen);
    return { status: r.responses[0].status, body: JSON.stringify(r.responses[0].body), log: (r.logs || []).join(' | ').slice(0, 260) };
  }
  function cron(ts) {
    const scen = `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CANTEEN_AUTORELOAD_CRON_SECRET: 'cron_s' };
${bridge(db, ['update_canteen_autoreload_state', 'claim_refund_intent', 'release_refund_intent', 'camp_families_object', 'credit_canteen_balance_from_processor'], ['camp_state_kv'])}
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
${ts ? `const __RealDate = Date; (globalThis as any).Date = class extends __RealDate { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(${ts}); } static now() { return ${ts}; } };` : ''}
T.requests = [{ headers: { 'x-cron-secret': 'cron_s' }, body: {} }];`;
    const r = runEdges(['canteen-auto-reload'], scen);
    const b = r.responses[0].body || {};
    return (b.details || []).map((d) => d.camper ? `${d.camper} $${d.amount} → ${d.result}` : `camp → ${d.result}`).join('; ') || JSON.stringify(b).slice(0, 300) + ' ' + (r.logs || []).join(' | ').slice(0, 300);
  }

  console.log('K0. The secret on the URL (&key=), as the guides now allow');
  const ping = { xResponseRefnum: 'nope', xStatus: 'Chargeback' };
  const k0a = byop(ping, '&key=sek_long_value');
  const k0b = byop(ping, '&key=wrong');
  const k0c = byop(ping, '');
  console.log(`  right key → HTTP ${k0a.status} ${k0a.body}; wrong key → ${k0b.status}; no key → ${k0c.status}`);
  check(k0a.status === 200 && k0b.status === 401 && k0c.status === 401, 'K0 &key= accepted, wrong/missing refused', `${k0a.status}/${k0b.status}/${k0c.status}`);

  console.log(`\nK1. Birch paid $500 by Cardknox (ref 9001); owes $${owes('birch')}. Cardknox sends its ordinary TRANSACTION postback for that sale to the dispute URL`);
  const k1 = byop({ xResponseRefnum: '9001', xGatewayRefNum: '9001', xStatus: 'Approved', xCommand: 'cc:sale', xInvoice: 'INV-birch' }, '&key=sek_long_value');
  const h1 = fam('birch').disputeHold;
  const cb1 = (fam('birch').entries || []).filter((e) => /^le_cb_/.test(e.id)).map((e) => `${e.id} $${e.amount}`).join(', ') || 'none';
  console.log(`  HTTP ${k1.status} ${k1.body}; chargeback lines: ${cb1}; Birch now owes $${owes('birch')}; pause ${h1 ? JSON.stringify(h1.disputeIds) : 'none'}`);
  console.log(`  log: ${k1.log}`);
  check(cb1 === 'none' && !h1, 'K1 an ordinary approved sale postback posts no chargeback and pauses nobody', `chargebacks ${cb1}, pause ${h1 ? 'yes' : 'no'}`);

  console.log(`\nK2. Eli (Cardknox camp): auto-reload "below $5 → add $20" on tok_eli; wallet $${wallet()}`);
  console.log(`  run today: ${cron()}`);
  console.log(`  wallet $${wallet()}; tok_eli sales: ${sales('tok_eli')}`);
  const k2 = byop({ xResponseRefnum: '7001', xGatewayRefNum: '7001', xStatus: 'Chargeback', xStatusReason: 'Unrecognized', xCommand: 'cc:sale' }, '&key=sek_long_value');
  console.log(`  parent disputes the $20 (ref 7001): HTTP ${k2.status} ${k2.body}`);
  console.log(`  log: ${k2.log}`);
  console.log(`  wallet now $${wallet()}; auto-reload: ${arState()}`);
  console.log(`  next day (${iso(now + DAY)}), after Eli spends it: `);
  q(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${C}','Eli'); PERFORM public.canteen_account_save('${C}','Eli', a || '{"balance": 0}'::jsonb); END $x$;`);
  console.log(`    run: ${cron(now + DAY)}`);
  console.log(`  tok_eli sales: ${sales('tok_eli')}`);
  check(sales('tok_eli').split(',').length === 1, 'K2 the card whose Cardknox top-up is disputed is not charged again while the bank decides', sales('tok_eli'));

  console.log('\nK4. Birch\'s chargeback (ck_9001, posted in K1) is reversed in the camp\'s favour: Cardknox status "Chargeback Reversal"');
  const k4 = byop({ xResponseRefnum: '9001', xGatewayRefNum: '9001', xStatus: 'Chargeback Reversal', xCommand: 'cc:sale' }, '&key=sek_long_value');
  const won4 = (fam('birch').entries || []).filter((e) => /^le_cbwon_/.test(e.id)).map((e) => `${e.id} $${e.amount}`).join(', ') || 'none';
  console.log(`  HTTP ${k4.status} ${k4.body}; win lines: ${won4}; Birch owes $${owes('birch')}; pause ${JSON.stringify((fam('birch').disputeHold || {}).disputeIds || 'none')}`);
  check(won4 !== 'none', 'K4 a "Chargeback Reversal" is read as the camp winning (money back on the books, pause lifted)', won4);

  console.log('\nK3. The TED-206 retry rule');
  const k3a = byop({ xResponseRefnum: '9001', xStatus: 'Chargeback' }, '&key=sek_long_value', {}, `T.rpc.record_chargeback = () => { throw new Error('canceling statement due to statement timeout'); };`);
  const k3b = byop({ xResponseRefnum: 'nosuch', xStatus: 'Chargeback' }, '&key=sek_long_value');
  const k3c = byop({ xResponseRefnum: '9001', xStatus: 'Chargeback' }, '&key=sek_long_value', {}, `T.rpc.hold_autopay_for_dispute = () => { throw new Error('statement timeout'); };`);
  console.log(`  posting DB error → HTTP ${k3a.status}; unknown payment → HTTP ${k3b.status}; pause DB error → HTTP ${k3c.status}`);
  check(k3a.status === 500 && k3b.status === 200 && k3c.status === 500, 'K3 DB errors 500, answers 200', `${k3a.status}/${k3b.status}/${k3c.status}`);
} catch (e) {
  check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 4).join(' | '));
} finally {
  db.stop();
  console.log(`\n${bad} BAD`);
}
