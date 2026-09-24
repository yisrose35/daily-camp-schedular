// Proof (4th pass): the same question as deposit_before_ledger.js, for an ordinary
// recorded payment (camp_payments, e.g. a check the office typed in, or a card
// payment) made before the family's ledger was started by Billing's first render.
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5493 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a4a3', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b4b3';
const AS = `SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);`;
const q = s => db.sql(AS + s).trim().split('\n').pop();
const lit = o => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const row = () => JSON.parse(q(`SELECT (camp_families_object('${CAMP}')->'blue')::text;`));
try {
  const plan = { id: 'plan_1', autopay: true, dueDates: ['2026-06-01', '2026-07-01'], nextIndex: 0 };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', jsonb_build_object('families', jsonb_build_object('blue', ${lit({ name: 'Blue', camperIds: ['Dov Blue'], plans: [plan] })})));`);
  // office records a $300 check before Billing ever rendered this family's ledger
  console.log('record $300 check:', q(`SELECT sync_camp_billing('${CAMP}', '{}'::jsonb, '[]'::jsonb, ${lit([{ id: 'pay_1', familyKey: 'blue', family: 'Blue', amount: 300, method: 'Check', status: 'paid', date: '2026-05-20' }])}, '[]'::jsonb)::text;`));
  const f = row();
  f.entries = [{ id: 'le_t1', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-21', source: { enrollmentId: 'e1' } }];
  q(`SELECT sync_camp_billing('${CAMP}', jsonb_build_object('blue', ${lit(f)}), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);`);
  console.log('after first render: ledger balance', q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'blue');`), '(should be 700)');
  console.log('  autopay due 1 Jun:', q(`SELECT plan_due_for('${CAMP}','blue','plan_1','2026-06-01')::text;`));
  console.log('  all payments posted? (parent-side completeness):', q(`SELECT family_payments_all_posted(camp_families_object('${CAMP}')->'blue', projected_family_payments('${CAMP}','blue'), 'blue');`));
} finally { db.stop && db.stop(); }
