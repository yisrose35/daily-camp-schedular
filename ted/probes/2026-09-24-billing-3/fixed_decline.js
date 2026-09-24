// Proof: a plan with office-set amounts (264). The first payment is declined; the
// runner records the decline (charged 0, counter moves on, as it does for every
// ledger plan). Who collects the declined $1,000?
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5473 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a3a3', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b3b3';
const q = s => db.sql(s).trim().split('\n').pop();
const lit = o => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
try {
  const fam = { name: 'Gold', camperIds: ['Avi Gold'],
    entries: [{ id: 'le_t', kind: 'charge', amount: 1400, reason: 'tuition' }],
    plans: [{ id: 'plan_1', autopay: true, dueDates: ['2026-06-01', '2026-07-01', '2026-08-01'], amounts: [1000, 200, 200], nextIndex: 0 }] };
  db.sql(`INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', jsonb_build_object('families', jsonb_build_object('gold', ${lit(fam)})));`);
  const due = d => q(`SELECT plan_due_for('${CAMP}','gold','plan_1','${d}')::text;`);
  const bal = () => q(`SELECT family_ledger_balance(camp_families_object('${CAMP}')->'gold');`);
  console.log('1 Jun due:', due('2026-06-01'));
  console.log('card declines -> record_autopay_charge(charged 0):', q(`SELECT record_autopay_charge('${CAMP}','gold','plan_1',0,'2026-06-01',0,'declined: card declined')::text;`));
  console.log('1 Jul due:', due('2026-07-01'));
  q(`SELECT record_autopay_charge('${CAMP}','gold','plan_1',1,'2026-07-01',200,NULL,NULL,'pi_jul');`);
  console.log('1 Aug due:', due('2026-08-01'));
  q(`SELECT record_autopay_charge('${CAMP}','gold','plan_1',2,'2026-08-01',200,NULL,NULL,'pi_aug');`);
  console.log('after the last date, due:', due('2026-09-01'), ' balance still owed:', bal());
  // Same plan WITHOUT amounts (the old even split), for comparison
  const fam2 = JSON.parse(JSON.stringify(fam)); delete fam2.plans[0].amounts;
  q(`SELECT camp_family_save('${CAMP}','gold2', ${lit(fam2)});`);
  q(`SELECT record_autopay_charge('${CAMP}','gold2','plan_1',0,'2026-06-01',0,'declined: card declined');`);
  console.log('even-split plan, 1 Jul due after the same decline:', q(`SELECT plan_due_for('${CAMP}','gold2','plan_1','2026-07-01')::text;`));
} finally { db.stop && db.stop(); }
