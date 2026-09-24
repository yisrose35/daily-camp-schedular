// Proof: a family whose balance comes from its posted ledger pays $400 by Zelle.
// deposit-inbox records it in bank_deposits as 'posted' to that family. Does the
// ledger balance (what the office's Billing and autopay use) go down?
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5476 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a3a6', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b3b6';
const q = s => db.sql(s).trim().split('\n').pop();
const lit = o => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
try {
  const fam = { name: 'Gold', camperIds: ['Avi Gold'],
    entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition', source: { enrollmentId: 'e1' } }],
    plans: [{ id: 'plan_1', autopay: true, dueDates: ['2026-06-01', '2026-07-01'], nextIndex: 0 }] };
  db.sql(`INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', jsonb_build_object('families', jsonb_build_object('gold', ${lit(fam)})));`);
  console.log('before: ledger balance', q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold');`),
              '| autopay due 1 Jun:', q(`SELECT plan_due_for('${CAMP}','gold','plan_1','2026-06-01')::text;`));
  // what _deposit_record writes for an auto-matched Zelle payment
  console.log('_deposit_record:', q(`SELECT _deposit_record('${CAMP}', 'fp1', 40000, '{"date":"2026-05-30","payerName":"GOLD","kind":"zelle"}'::jsonb, '{"decision":"auto","familyKey":"gold","confidence":95}'::jsonb)::text;`));
  console.log('bank_deposits row:', q(`SELECT status || ' ' || family_key || ' ' || amount_cents FROM bank_deposits WHERE camp_id='${CAMP}';`));
  console.log('after: ledger balance', q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold');`),
              '| autopay due 1 Jun:', q(`SELECT plan_due_for('${CAMP}','gold','plan_1','2026-06-01')::text;`));
} finally { db.stop && db.stop(); }
