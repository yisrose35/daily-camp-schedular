// Proof (4th pass): what the PARENT sees (get_my_balance) after server-side writes
// to a family's ledger row — a Zelle deposit (265) and an autopay payment
// (record_autopay_charge). get_my_balance reads family_ledger_projection, which
// only migration 202's trigger on the campistryMe settings document fills.
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5495 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a4a5', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b4b5', PARENT = 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c4c5';
const as = u => `SELECT set_config('request.jwt.claims','{"sub":"${u}"}',false);`;
const q = (s, u = OWNER) => db.sql(as(u) + s).trim().split('\n').pop();
const lit = o => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const parent = () => { const b = JSON.parse(q(`SELECT get_my_balance('${CAMP}')::text;`, PARENT)); return `ledger=${b.ledger} balance=${b.balance}` + (b.ledgerIncomplete ? ' (incomplete)' : ''); };
const office = () => q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold');`);
try {
  const fam = { name: 'Gold', camperIds: ['Avi Gold'],
    entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', source: { enrollmentId: 'e1' } }],
    plans: [{ id: 'plan_1', autopay: true, dueDates: ['2026-06-01', '2026-07-01'], nextIndex: 0 }] };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t'), ('${PARENT}','p@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', jsonb_build_object(
      'sessions', '[{"name":"Full","tuition":1000}]'::jsonb,
      'enrollments', '{"e1":{"camperName":"Avi Gold","status":"enrolled","session":"Full","sessionTuition":1000}}'::jsonb,
      'families', jsonb_build_object('gold', ${lit(fam)})));
    INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, status)
      VALUES ('${CAMP}', '${PARENT}', 'p@t', '["Avi Gold"]', 'active');`);
  console.log('start      : office', office(), '| parent', parent());
  q(`SELECT _deposit_record('${CAMP}', 'fpP', 40000, '{"date":"2026-05-30","payerName":"GOLD","kind":"zelle"}'::jsonb, '{"decision":"auto","familyKey":"gold","confidence":95}'::jsonb);`);
  console.log('Zelle $400 : office', office(), '| parent', parent(), '(both should be 600)');
  console.log('autopay $300 recorded:', q(`SELECT record_autopay_charge('${CAMP}','gold','plan_1',0,'2026-06-01',300,'pi_1')::text;`));
  console.log('after it   : office', office(), '| parent', parent(), '(both should be 300)');
  // the office opens Me and its page saves the settings document (families copied from the rows it loaded)
  q(`UPDATE camp_state_kv SET value = jsonb_set(value, '{families,gold}', camp_families_object('${CAMP}')->'gold') WHERE camp_id='${CAMP}' AND key='campistryMe'; SELECT 1;`);
  console.log('office save: office', office(), '| parent', parent());
} finally { db.stop && db.stop(); }
