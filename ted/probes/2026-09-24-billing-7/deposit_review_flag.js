// Probe (7th pass, TED-103 re-check) on a scratch DB with the real chain.
// The runner flags an autopay plan 'deposit_review' each night the card-deposit
// question is open. That goes through flag_plan_collection — the DECLINE
// machinery. What does the plan look like after 3 nights, what does the office
// get told, and does answering the question (a normal page save with the
// question gone) let autopay run again?
// Part 2: an owner who pasted the 3390aba copy of 269 and now re-pastes 269,
// as the builder's steps say: does the notice text learn 'deposit_review'?
// Run: node ted/probes/2026-09-24-billing-7/deposit_review_flag.js
const R = '/home/user/daily-camp-schedular', fs = require('fs'), cp = require('child_process');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5531 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a7a1', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b7b1';
const AS = `SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);`;
const q = s => db.sql(AS + s).trim().split('\n').pop();
const lit = o => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const row = k => JSON.parse(q(`SELECT (camp_families_object('${CAMP}')->'${k}')::text;`));
const save = (k, f) => q(`SELECT sync_camp_billing('${CAMP}', jsonb_build_object('${k}', ${lit(f)}), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)::text;`);
try {
  const plan = { id: 'plan_a', dueDates: ['2026-06-01', '2026-07-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false, total: 1000 };
  const fam = { name: 'Gold', camperIds: ['Avi'], cardOnFile: true, stripeCustomerId: 'cus_G', plans: [plan],
                depositReview: [{ ref: 'pi_dep', amount: 250, paymentId: 'pay_hand', date: '2026-05-01', camperName: 'Avi' }] };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', jsonb_build_object('families', jsonb_build_object('gold', ${lit(fam)})));`);
  const officeTab = row('gold');   // the office's Billing tab, loaded before the nights below
  console.log('server copy carries the question:', JSON.stringify(officeTab.depositReview));
  const detail = 'a card deposit of $250.00 may already have been recorded by hand — answer the question on this family in Billing; autopay waits until then';
  for (let n = 1; n <= 3; n++) {
    // what the runner sends each night the question is open (charge-due-installments/index.ts:637)
    const r = q(`SELECT flag_plan_collection('${CAMP}','gold','plan_a','deposit_review',${lit(detail).replace('::jsonb', '')})::text;`);
    console.log(`night ${n}: ${r}`);
  }
  console.log('\nplan.collectionBlocked after 3 nights:', JSON.stringify(row('gold').plans[0].collectionBlocked));
  console.log('\nnotifications sent:');
  db.sql(`SELECT title || ' | ' || body FROM notifications WHERE camp_id='${CAMP}' ORDER BY created_at, source_id;`).trim().split('\n').forEach(l => console.log('  - ' + l));

  // The office answers "different payment" in that tab: the question goes, the page saves the family.
  officeTab.depositReview = [];
  officeTab.depositReviewed = { pi_dep: 'separate' };
  save('gold', officeTab);
  const after = row('gold');
  console.log('\nafter the office answered and saved: depositReview =', JSON.stringify(after.depositReview),
              '| plan.collectionBlocked =', JSON.stringify(after.plans[0].collectionBlocked));

  // Part 2: 269 re-pasted over the 3390aba copy.
  const def214 = fs.readFileSync(R + '/migrations/214_family_writers_row_truth.sql', 'utf8')
    .match(/CREATE OR REPLACE FUNCTION public\.flag_plan_collection\([\s\S]*?\n\$\$;/)[0];
  const old269 = cp.execSync(`git -C ${R} show 3390aba:migrations/269_every_plan_can_hold_a_bank_debit.sql`, { encoding: 'utf8', maxBuffer: 1 << 26 });
  const new269 = fs.readFileSync(R + '/migrations/269_every_plan_can_hold_a_bank_debit.sql', 'utf8');
  db.sql(def214);                   // the function as 214 left it
  db.sql(old269);                   // the owner's earlier paste of 269
  const has = () => q(`SELECT (position('deposit_review' in pg_get_functiondef('public.flag_plan_collection(uuid,text,text,text,text)'::regprocedure)) > 0)::text;`);
  console.log('\n269 (3390aba copy) pasted: notice text knows deposit_review?', has());
  db.sql(new269);                   // re-pasted, as the builder's steps say
  console.log('269 (66a65df copy) re-pasted:  notice text knows deposit_review?', has());
  console.log('fresh database with only today\'s 269 (the test chain): see pgtest 269 — this probe booted with it, and part 1 above shows its wording.');
} finally { db.stop && db.stop(); }
