// Probe (5th pass): TED-088/077 — what the PARENT (get_my_balance) sees, with no
// office save in between, across: a shop order billed then cancelled, a Zelle
// deposit, an autopay charge, and a refund recorded by the Stripe webhook
// (record_external_refund). record_autopay_charge called the way charge-due-installments calls it
// (p_payment + p_dedupe_key = the intent id) and then the webhook's own row for the same intent. Office figure = the family row's ledger.
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5514 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a514', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b514', PARENT = 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c514';
const as = u => `SELECT set_config('request.jwt.claims','{"sub":"${u}"}',false);`;
const q = (s, u = OWNER) => db.sql(as(u) + s).trim().split('\n').pop();
const lit = o => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const parent = () => { const b = JSON.parse(q(`SELECT get_my_balance('${CAMP}')::text;`, PARENT)); return `ledger=${b.ledger} balance=${b.balance}` + (b.ledgerIncomplete ? ' (INCOMPLETE -> derived)' : ''); };
const office = () => q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold');`);
const show = l => console.log(l.padEnd(34), 'office', office(), '| parent', parent());
try {
  const fam = { name: 'Gold', camperIds: ['Avi Gold'],
    entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', source: { enrollmentId: 'e1' } }],
    plans: [{ id: 'plan_1', autopay: true, dueDates: ['2026-06-01', '2026-07-01'], nextIndex: 0 }] };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t'), ('${PARENT}','p@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', 1, 'camper', 'Avi Gold', 'Avi Gold');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryShop','{"orders":[{"id":"o1","camperName":"Avi Gold","camperId":1,"payMethod":"bill"}]}'::jsonb);
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', jsonb_build_object(
      'sessions', '[{"name":"Full","tuition":1000}]'::jsonb,
      'enrollments', '{"e1":{"camperName":"Avi Gold","camperId":1,"status":"enrolled","session":"Full","sessionTuition":1000}}'::jsonb,
      'families', jsonb_build_object('gold', ${lit(fam)})));
    INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, status)
      VALUES ('${CAMP}', '${PARENT}', 'p@t', '["Avi Gold"]', 'active');`);
  show('start');
  q(`SELECT settle_shop_order('${CAMP}','o1','bill',40);`); show('shop bills $40');
  q(`SELECT settle_shop_order('${CAMP}','o1','none',0);`); show('shop order cancelled');
  q(`SELECT _deposit_record('${CAMP}', 'fpP', 40000, '{"date":"2026-05-30","payerName":"GOLD","kind":"zelle"}'::jsonb, '{"decision":"auto","familyKey":"gold","confidence":95}'::jsonb);`); show('Zelle $400');
  q(`SELECT record_autopay_charge('${CAMP}','gold','plan_1',0,'2026-06-01',300,NULL,'{"id":"auto_pi_1","familyKey":"gold","amount":300,"method":"Autopay (card)","reference":"pi_1","stripePaymentIntentId":"pi_1","status":"succeeded","date":"2026-06-01"}'::jsonb,'pi_1');`); show('autopay $300 (pi_1)');
  console.log('  webhook payment row for pi_1:', q(`SELECT append_camp_payment('${CAMP}', '{"id":"pi_1","familyKey":"gold","family":"Gold","amount":300,"method":"Card","status":"succeeded","stripePaymentIntentId":"pi_1","date":"2026-06-01"}'::jsonb, 'pi_1')::text;`).slice(0, 140));
  show('after the payment row');
  console.log('  webhook refund $50 of pi_1:', q(`SELECT record_external_refund('${CAMP}','re_1',ARRAY['pi_1'],50,'Refund issued at the processor')::text;`));
  show('after the refund');
} finally { db.stop && db.stop(); }
