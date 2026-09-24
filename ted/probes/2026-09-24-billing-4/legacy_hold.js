// TED-084 re-check on the scratch DB: the old single f.plan ('#0') holds a debit and
// keeps it through a stale page save. Then: plans without ids are matched by
// POSITION when the page saves — what if the office removed the first one?
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5499 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a4a9', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b4b9';
const AS = `SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);`;
const q = s => db.sql(AS + s).trim().split('\n').pop();
const lit = o => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const row = k => JSON.parse(q(`SELECT (camp_families_object('${CAMP}')->'${k}')::text;`));
const save = (k, f) => q(`SELECT sync_camp_billing('${CAMP}', jsonb_build_object('${k}', ${lit(f)}), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text;`);
const HOLD = `'{"paymentIntentId":"pi_ach_1","dueDate":"2026-06-01","amount":500,"since":"2026-06-01"}'::jsonb`;
try {
  const legacy = { autopay: true, total: 1000, installments: [{ n: 1, amount: 500, dueDate: '2026-06-01', status: 'pending' }, { n: 2, amount: 500, dueDate: '2026-07-01', status: 'pending' }] };
  const A = { autopay: true, total: 300, installments: [{ n: 1, amount: 300, dueDate: '2026-06-01', status: 'pending' }] };
  const Bp = { autopay: true, total: 200, installments: [{ n: 1, amount: 200, dueDate: '2026-06-15', status: 'pending' }] };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', jsonb_build_object('families', jsonb_build_object(
      'old', ${lit({ name: 'Old', camperIds: ['X'], plan: legacy })}, 'two', ${lit({ name: 'Two', camperIds: ['Y'], plans: [A, Bp] })})));`);
  const tabOld = row('old'), tabTwo = row('two');
  console.log('hold on old single plan #0:', q(`SELECT hold_autopay_charge('${CAMP}','old','#0',${HOLD})::text;`));
  console.log('flag old single plan #0   :', q(`SELECT flag_plan_collection('${CAMP}','old','#0','declined','test')->>'success';`));
  tabOld.notes = 'edited in a stale tab';
  save('old', tabOld);
  const o = row('old');
  console.log('after stale save: plan.pendingCharge =', JSON.stringify(o.plan.pendingCharge), '| collectionBlocked.reason =', o.plan.collectionBlocked && o.plan.collectionBlocked.reason);
  // Plans without ids: runner holds a debit on the FIRST (#0, $300)
  console.log('\nhold on plans[0] (#0, the $300 plan):', q(`SELECT hold_autopay_charge('${CAMP}','two','#0',${HOLD})::text;`));
  // office, in a tab opened before, deletes the $300 plan (keeps only the $200 one) and saves
  tabTwo.plans = [tabTwo.plans[1]];
  save('two', tabTwo);
  const t = row('two');
  console.log('after the office removed the $300 plan: plans =', JSON.stringify(t.plans.map(p => ({ total: p.total, pendingCharge: p.pendingCharge || null }))));
} finally { db.stop && db.stop(); }
