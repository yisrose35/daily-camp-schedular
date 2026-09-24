// Proof: a camp that ran convert_family_ledgers, with a Camp Shop order billed
// BEFORE the conversion. The order is then re-priced / cancelled through the real
// settle_shop_order (263). Does the family's ledger balance follow?
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5471 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a3a1', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b3b1';
const AS = `SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);`;
const q = s => db.sql(AS + s).trim().split('\n').pop();
const bal = () => q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold');`);
try {
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('${CAMP}', 1, 'camper', 'Avi Gold', 'Avi Gold');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryShop','{"orders":[{"id":"o1","camperName":"Avi Gold","camperId":1,"payMethod":"bill","settlement":{"method":"bill","amount":40}}]}'::jsonb);
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', '${JSON.stringify({
      sessions: [{ name: 'Full', tuition: 1000 }],
      enrollments: { e1: { camperName: 'Avi Gold', session: 'Full', status: 'enrolled' } },
      families: { gold: { name: 'Gold', camperIds: ['Avi Gold'],
        charges: [{ id: 'shop_o1', category: 'Camp Shop', description: 'Camp Shop order', amount: 40, date: '2026-07-01', shopOrderId: 'o1' }] } },
      finance: { payments: [{ id: 'p1', familyKey: 'gold', amount: 1000, status: 'succeeded', stripePaymentIntentId: 'pi_1' }] } })}'::jsonb);`);
  console.log('convert:', q(`SELECT convert_family_ledgers('${CAMP}', false)::text;`));
  console.log('balance after conversion (tuition 1000 - paid 1000 + shop 40): ', bal());
  console.log('re-price the order to $55:', q(`SELECT settle_shop_order('${CAMP}','o1','bill',55)::text;`));
  let fam = JSON.parse(q(`SELECT (camp_families_object('${CAMP}')->'gold')::text;`));
  console.log('  charges[]:', JSON.stringify(fam.charges.map(c => c.id + ' $' + c.amount)));
  console.log('  ledger charges:', fam.entries.filter(e => e.kind === 'charge').map(e => e.id + ' $' + e.amount).join(', '));
  console.log('  balance (should be 55):', bal());
  console.log('cancel the order:', q(`SELECT settle_shop_order('${CAMP}','o1','bill',55,true)::text;`));
  fam = JSON.parse(q(`SELECT (camp_families_object('${CAMP}')->'gold')::text;`));
  console.log('  charges[]:', JSON.stringify((fam.charges || []).map(c => c.id)));
  console.log('  ledger:', fam.entries.map(e => e.id + ':' + e.kind + ' $' + e.amount).join(', '));
  console.log('  balance (should be 0):', bal());
} finally { db.stop && db.stop(); }
