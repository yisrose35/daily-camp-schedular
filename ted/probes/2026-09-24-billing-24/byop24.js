// Probe (24th pass, byop24). REAL byop-dispute-webhook + REAL canteen-auto-reload
// at HEAD (a4546ec, incl. dfddc3b fixes), on the REAL migration chain.
// Re-checks TED-212 (K1/K4/K5), TED-211 (K2), TED-210 (K2 sibling), TED-207-canteen edge (K6).
'use strict';
const R = '/home/user/daily-camp-schedular';
const { runEdges } = require(R + '/tests/edge_harness.js');
const { bridge } = require(R + '/ted/probes/2026-09-24-billing-10/realdb_bridge.js');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5847 });
const OWNER = '0ed23b00-0000-0000-0000-0000000000a1';
const C = '0ed23b00-0000-0000-0000-000000000001';
const q = (s) => db.sql(s).trim();
const lit = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const now = Date.now();
let bad = 0;
const check = (ok, label, detail) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'BAD '}${label}   → ${detail}`); };
// every RPC the fixed byop path touches
const RPCS = ['resolve_chargeback', 'hold_autopay_for_dispute', 'note_dispute_lost', 'camp_families_object',
  'canteen_dispute_family', 'record_canteen_stripe_reversal', 'pause_canteen_autoreload_for_dispute'];
try {
  q(`CREATE TABLE ted_sales (id serial, token text, cents int, day text);
     INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t24');
     INSERT INTO camps (id, owner, name, payment_processor_key) VALUES ('${C}','${OWNER}','Sola Camp','cardknox');
     INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
        ('${C}', 11, 'camper', 'Eli', 'Eli'), ('${C}', 13, 'camper', 'Ezra', 'Ezra'), ('${C}', 12, 'camper', 'Birch Kid', 'Birch Kid');
     SELECT public.canteen_account_save('${C}', 'Eli', '{"balance": 0, "camperId": 11}'::jsonb);
     SELECT public.canteen_account_save('${C}', 'Ezra', '{"balance": 0, "camperId": 13}'::jsonb);`);
  // Eli auto-reload on tok_eli; Ezra (same family) auto-reload on a DIFFERENT card tok_ezra
  q(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${C}','Eli');
     PERFORM public.canteen_account_save('${C}','Eli', a || jsonb_build_object('camperId', 11, 'autoReload', ${lit({ enabled: true, cardOnFile: true, byopCustomerRef: 'tok_eli',
       thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 })}));
     a := public.canteen_account_lock('${C}','Ezra');
     PERFORM public.canteen_account_save('${C}','Ezra', a || jsonb_build_object('camperId', 13, 'autoReload', ${lit({ enabled: true, cardOnFile: true, byopCustomerRef: 'tok_ezra',
       thresholdEnabled: true, thresholdAmount: 5, thresholdReloadAmount: 20, scheduleEnabled: false, maxReloadsPerPeriod: 1, reloadPeriodDays: 1 })})); END $x$;`);
  const sessions = [{ id: 's1', name: 'Summer', startDate: iso(now - 20 * DAY), endDate: iso(now + 30 * DAY), dates: '', tuition: 1000, capacity: 100 }];
  const fams = {
    birch: { name: 'Birch', camperIds: ['Birch Kid'], byopCustomerRef: 'tok_birch', cardOnFile: true,
      entries: [{ id: 'c_birch', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-01' },
                { id: 'pay_birch', kind: 'payment', amount: 500, method: 'card', date: '2026-06-01', source: { paymentId: '9001', processor: 'cardknox' } }] },
    elif: { name: 'Eli family', camperIds: ['Eli', 'Ezra'], byopCustomerRef: 'tok_family', cardOnFile: true, entries: [] },
  };
  q(`INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${C}', 'campistryMe', ${lit({ families: fams, enrollments: {}, sessions, sessionBundles: [], enrollSettings: {} })}),
       ('${C}', 'campDates', ${lit({ startDate: sessions[0].startDate, endDate: sessions[0].endDate })});
     SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);
     SELECT public.sync_camp_billing('${C}', ${lit(fams)}, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);`);
  const fam = (k) => JSON.parse(q(`SELECT public.camp_family('${C}','${k}')::text`));
  const owes = (k) => { const f = fam(k); return (f.entries || []).reduce((t, e) => t + (e.kind === 'charge' ? +e.amount : e.kind === 'payment' ? -e.amount : e.kind === 'refund' ? +e.amount : 0), 0); };
  const wallet = (pid) => q(`SELECT coalesce(balance,0) FROM camp_canteen_accounts WHERE camp_id='${C}' AND person_id=${pid}`);
  const arState = (name) => q(`SELECT (a->'autoReload'->>'enabled') || ' / ' || coalesce(a->'autoReload'->>'disabledReason','-') FROM (SELECT public.canteen_account_lock('${C}','${name}') a) x`);
  const sales = (tok) => q(`SELECT coalesce(string_agg(day || ' $' || (cents/100), ', ' ORDER BY id), 'none') FROM ted_sales WHERE token='${tok}'`);

  function byop(body, urlExtra, headers, over) {
    const scen = `
T.env = { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'svc', BYOP_DISPUTE_SECRET: 'sek_long_value' };
${bridge(db, RPCS, [])}
T.rpc.record_chargeback = (a: any) => {
  const L = (v: any) => v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
  return JSON.parse((T as any).__q('SELECT public.record_chargeback(p_camp_id => ' + L(a.p_camp_id) + '::uuid, p_dispute_id => ' + L(a.p_dispute_id)
    + ', p_refs => ARRAY[' + (a.p_refs || []).map(L).join(',') + ']::text[], p_amount => ' + (a.p_amount == null ? 'NULL' : Number(a.p_amount)) + ', p_reason => ' + L(a.p_reason) + ', p_status => ' + L(a.p_status) + ')::text'));
};
${over || ''}
T.requests = [{ url: 'http://edge.test/byop-dispute-webhook?processor=cardknox&camp=${C}${urlExtra}', headers: ${JSON.stringify(headers || {})}, rawBody: ${JSON.stringify(JSON.stringify(body))} }];`;
    const r = runEdges(['byop-dispute-webhook'], scen);
    return { status: r.responses[0].status, body: JSON.stringify(r.responses[0].body), log: (r.logs || []).join(' | ').slice(0, 300) };
  }
  function cron(ts) {
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
${ts ? `const __RealDate = Date; (globalThis as any).Date = class extends __RealDate { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(${ts}); } static now() { return ${ts}; } };` : ''}
T.requests = [{ headers: { 'x-cron-secret': 'cron_s' }, body: {} }];`;
    const r = runEdges(['canteen-auto-reload'], scen);
    const b = r.responses[0].body || {};
    return (b.details || []).map((d) => d.camper ? `${d.camper} $${d.amount} → ${d.result}` : `camp → ${d.result}`).join('; ') || JSON.stringify(b).slice(0, 300) + ' ' + (r.logs || []).join(' | ').slice(0, 300);
  }

  console.log('K1. TED-212: Birch paid $500 by Cardknox (ref 9001). Cardknox sends its ORDINARY transaction postback (Approved cc:sale) to the dispute URL');
  const k1 = byop({ xResponseRefnum: '9001', xGatewayRefNum: '9001', xStatus: 'Approved', xCommand: 'cc:sale', xInvoice: 'INV-birch' }, '&key=sek_long_value');
  const h1 = fam('birch').disputeHold;
  const cb1 = (fam('birch').entries || []).filter((e) => /^le_cb_/.test(e.id)).map((e) => `${e.id} $${e.amount}`).join(', ') || 'none';
  console.log(`  HTTP ${k1.status} ${k1.body}; chargeback lines: ${cb1}; Birch owes $${owes('birch')}; pause ${h1 ? JSON.stringify(h1.disputeIds) : 'none'}`);
  check(cb1 === 'none' && !h1 && /not_a_chargeback/.test(k1.body), 'K1 an ordinary Approved sale posts NO chargeback and pauses nobody', `cb ${cb1}, pause ${h1 ? 'yes' : 'no'}, body ${k1.body}`);

  console.log('\nK1b. TED-212: a refund and a void sent to the dispute URL are also ignored');
  const k1r = byop({ xResponseRefnum: '9001', xStatus: 'Approved', xCommand: 'cc:refund' }, '&key=sek_long_value');
  const k1v = byop({ xResponseRefnum: '9001', xStatus: 'Approved', xCommand: 'cc:void' }, '&key=sek_long_value');
  check(/not_a_chargeback/.test(k1r.body) && /not_a_chargeback/.test(k1v.body), 'K1b refund/void ignored', `${k1r.body} / ${k1v.body}`);

  console.log(`\nK2. TED-211/210: Eli auto-reload on tok_eli; Ezra (same family) auto-reload on tok_ezra; wallets Eli $${wallet(11)} Ezra $${wallet(13)}`);
  console.log(`  run today: ${cron()}`);
  console.log(`  after run: Eli $${wallet(11)} (tok_eli sales: ${sales('tok_eli')}), Ezra $${wallet(13)} (tok_ezra sales: ${sales('tok_ezra')})`);
  const k2 = byop({ xResponseRefnum: '7001', xGatewayRefNum: '7001', xStatus: 'Chargeback', xStatusReason: 'Unrecognized', xCommand: 'cc:sale' }, '&key=sek_long_value');
  console.log(`  parent disputes Eli's $20 top-up (ref 7001): HTTP ${k2.status} ${k2.body}`);
  console.log(`  log: ${k2.log}`);
  const eliWallet = wallet(11);
  const eliAR = arState('Eli');
  const famHold = fam('elif').disputeHold;
  console.log(`  Eli wallet now $${eliWallet}; Eli auto-reload: ${eliAR}; family pause: ${famHold ? JSON.stringify(famHold.disputeIds) : 'none'}`);
  check(String(eliWallet) === '0', 'K2a disputed top-up comes off Eli\'s wallet', `wallet $${eliWallet}`);
  check(/false/.test(eliAR), 'K2b Eli\'s auto-reload switched off', eliAR);
  check(!!famHold && (famHold.disputeIds || []).length > 0, 'K2c the FAMILY is paused (TED-210)', famHold ? JSON.stringify(famHold.disputeIds) : 'none');

  console.log(`\n  Next day (${iso(now + DAY)}): Eli spent it (wallet 0), Ezra spent it (wallet 0). Run again:`);
  q(`DO $x$ DECLARE a jsonb; BEGIN a := public.canteen_account_lock('${C}','Eli'); PERFORM public.canteen_account_save('${C}','Eli', a || '{"balance": 0}'::jsonb);
     a := public.canteen_account_lock('${C}','Ezra'); PERFORM public.canteen_account_save('${C}','Ezra', a || '{"balance": 0}'::jsonb); END $x$;`);
  console.log(`    run: ${cron(now + DAY)}`);
  console.log(`  tok_eli sales: ${sales('tok_eli')}; tok_ezra sales: ${sales('tok_ezra')}`);
  check(sales('tok_eli').split(',').length === 1, 'K2d Eli\'s card (disputed top-up) not charged again', sales('tok_eli'));
  check(sales('tok_ezra').split(',').length === 1, 'K2e Ezra (SIBLING, family paused) not charged again next day (TED-210)', sales('tok_ezra'));

  console.log('\nK4. TED-212 win: Eli\'s canteen chargeback (ck_7001) reversed in the camp\'s favour ("Chargeback Reversal")');
  const k4 = byop({ xResponseRefnum: '7001', xGatewayRefNum: '7001', xStatus: 'Chargeback Reversal', xCommand: 'cc:sale' }, '&key=sek_long_value');
  const eliWonWallet = wallet(11);
  const famHold2 = fam('elif').disputeHold;
  console.log(`  HTTP ${k4.status} ${k4.body}; Eli wallet $${eliWonWallet}; family pause now ${famHold2 ? JSON.stringify(famHold2.disputeIds) : 'none'}`);
  check(String(eliWonWallet) === '20', 'K4a a "Chargeback Reversal" puts the $20 back on the wallet', `wallet $${eliWonWallet}`);
  check(!famHold2 || (famHold2.disputeIds || []).length === 0, 'K4b family pause lifted on the win', famHold2 ? JSON.stringify(famHold2.disputeIds) : 'none');

  console.log('\nK3. TED-206 retry rule (canteen dispute path)');
  const k3a = byop({ xResponseRefnum: '7001', xStatus: 'Chargeback' }, '&key=sek_long_value', {}, `T.rpc.record_canteen_stripe_reversal = () => { throw new Error('canceling statement due to statement timeout'); };`);
  const k3b = byop({ xResponseRefnum: 'nosuch', xStatus: 'Chargeback' }, '&key=sek_long_value');
  console.log(`  reversal DB error → HTTP ${k3a.status}; unknown ref → HTTP ${k3b.status} ${k3b.body}`);
  check(k3a.status === 500 && k3b.status === 200, 'K3 DB error 500; genuinely unknown ref 200', `${k3a.status}/${k3b.status}`);
} catch (e) {
  check(false, 'the run finished', String(e.stack || e.message).split('\n').slice(0, 5).join(' | '));
} finally {
  db.stop();
  console.log(`\n${bad} BAD`);
}
