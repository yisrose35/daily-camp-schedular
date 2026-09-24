// Proof (4th pass): 265 posts a bank deposit to a family's ledger only if the
// family ALREADY has one. Billing starts a family's ledger on its first render
// after enrollment (tuition is posted on every render, campistry_me.js ~16170).
// A Zelle payment matched before that render: does it ever reach the ledger?
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5492 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a4a2', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b4b2';
const AS = `SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);`;
const q = s => db.sql(AS + s).trim().split('\n').pop();
const lit = o => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const row = () => JSON.parse(q(`SELECT (camp_families_object('${CAMP}')->'gold')::text;`));
try {
  const plan = { id: 'plan_1', autopay: true, dueDates: ['2026-06-01', '2026-07-01'], nextIndex: 0 };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', jsonb_build_object('families', jsonb_build_object('gold', ${lit({ name: 'Gold', camperIds: ['Avi Gold'], plans: [plan] })})));`);
  console.log('family just enrolled, no ledger entries yet:', JSON.stringify(row().entries || null));
  console.log('Zelle $400 auto-matched:', q(`SELECT (_deposit_record('${CAMP}', 'fpX', 40000, '{"date":"2026-05-20","payerName":"GOLD","kind":"zelle"}'::jsonb, '{"decision":"auto","familyKey":"gold","confidence":95}'::jsonb)->>'status');`));
  console.log('  entries after the deposit:', JSON.stringify(row().entries || null));
  // Office opens Billing: buildFamilyLedgers posts tuition (BillingCore.postTuition) and saves the family.
  const f = row();
  f.entries = [{ id: 'le_t1', kind: 'charge', amount: 1000, reason: 'tuition', date: '2026-05-21', source: { enrollmentId: 'e1' } }];
  q(`SELECT sync_camp_billing('${CAMP}', jsonb_build_object('gold', ${lit(f)}), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);`);
  console.log('after first Billing render: entries', row().entries.map(e => e.id + ' ' + e.kind + ' ' + e.amount).join(', '));
  console.log('  ledger balance', q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold');`),
              '(paid 400 by Zelle, so should be 600)');
  console.log('  autopay due 1 Jun:', q(`SELECT plan_due_for('${CAMP}','gold','plan_1','2026-06-01')::text;`));
  console.log('  covered by family_covers_deposit?', q(`SELECT family_covers_deposit(camp_families_object('${CAMP}')->'gold', (SELECT id FROM bank_deposits WHERE camp_id='${CAMP}'), 400, '2026-05-20');`));
} finally { db.stop && db.stop(); }
