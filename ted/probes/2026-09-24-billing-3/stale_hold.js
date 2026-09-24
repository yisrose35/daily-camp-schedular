// Proof: the runner's "bank debit in flight" hold (262) lives on the family row.
// The Me page writes whole family payloads (sync_camp_billing, and the blob save
// that the 211/234 trigger projects onto the rows). A Billing tab that loaded the
// family BEFORE the runner held the debit, then edits that family, writes its
// copy back — does the hold survive?
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5472 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a3a2', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b3b2';
const AS = `SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);`;
const q = s => db.sql(AS + s).trim().split('\n').pop();
const lit = o => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const plan = () => JSON.parse(q(`SELECT (camp_families_object('${CAMP}')->'gold'->'plans'->0)::text;`));
try {
  const fam = { name: 'Gold', camperIds: ['Avi Gold'],
    entries: [{ id: 'le_t', kind: 'charge', amount: 1000, reason: 'tuition' }],
    plans: [{ id: 'plan_1', autopay: true, dueDates: ['2026-06-01', '2026-07-01'], nextIndex: 0 }] };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', jsonb_build_object('families', jsonb_build_object('gold', ${lit(fam)})));`);
  // The office's Billing tab loads the family now (this is its copy).
  const tabCopy = JSON.parse(q(`SELECT (camp_families_object('${CAMP}')->'gold')::text;`));
  // That night the runner starts a $500 bank debit; Stripe says "processing"; the runner holds it.
  console.log('runner holds the debit:', q(`SELECT hold_autopay_charge('${CAMP}','gold','plan_1', '{"paymentIntentId":"pi_ach_1","index":0,"dueDate":"2026-06-01","amount":500,"since":"2026-06-01"}'::jsonb)::text;`));
  console.log('  plan.pendingCharge on the row:', JSON.stringify(plan().pendingCharge));
  // Next morning the office, in the same tab, adds a $10 charge to this family and it saves (sync_camp_billing).
  tabCopy.charges = [{ id: 'c_10', amount: 10, category: 'Other', description: 'Photo', date: '2026-06-02' }];
  console.log('office save (sync_camp_billing):', q(`SELECT sync_camp_billing('${CAMP}', jsonb_build_object('gold', ${lit(tabCopy)}), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text;`));
  console.log('  plan.pendingCharge on the row now:', JSON.stringify(plan().pendingCharge));
  console.log('  what the runner sees tonight: plan_due_for =', q(`SELECT plan_due_for('${CAMP}','gold','plan_1','2026-06-02')::text;`));
  // Same via the blob save (the page also writes campistryMe.families; the trigger projects it).
  q(`SELECT hold_autopay_charge('${CAMP}','gold','plan_1', '{"paymentIntentId":"pi_ach_1","index":0,"dueDate":"2026-06-01","amount":500,"since":"2026-06-01"}'::jsonb);`);
  tabCopy.charges.push({ id: 'c_11', amount: 5, category: 'Other', description: 'Snack', date: '2026-06-02' });
  q(`UPDATE camp_state_kv SET value = jsonb_set(value, '{families,gold}', ${lit(tabCopy)}) WHERE camp_id='${CAMP}' AND key='campistryMe'; SELECT 1;`);
  console.log('after the blob save (projection trigger), pendingCharge:', JSON.stringify(plan().pendingCharge));
} finally { db.stop && db.stop(); }
