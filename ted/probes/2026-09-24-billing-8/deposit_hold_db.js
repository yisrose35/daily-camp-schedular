// Probe (8th pass, TED-106 re-check) on a scratch DB with the real chain.
// 1. A plan left with the OLD runner's deposit_review flag (3 nights through
//    flag_plan_collection: attempts 3, retry date, escalated). The new runner
//    calls flag_plan_collection(..., null) once the question is gone
//    (charge-due-installments/index.ts:655-660). Is the flag fully gone?
// 2. The new runner's notice, inserted on 3 nights exactly as the runner does
//    (index.ts:641-648). How many rows does the office get?
// Run: node ted/probes/2026-09-24-billing-8/deposit_hold_db.js
const R = '/home/user/daily-camp-schedular';
const db = require(R + '/tests/e2e/db.js').boot({ port: 5541 });
const CAMP = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a8a1', OWNER = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b8b1';
const AS = `SELECT set_config('request.jwt.claims','{"sub":"${OWNER}"}',false);`;
const q = s => db.sql(AS + s).trim().split('\n').pop();
const lit = o => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";
const row = k => JSON.parse(q(`SELECT (camp_families_object('${CAMP}')->'${k}')::text;`));
try {
  const plan = { id: 'plan_a', dueDates: ['2026-06-01', '2026-07-01'], count: 2, nextIndex: 0, history: [], autopay: true, paused: false, total: 1000 };
  const fam = { name: 'Gold', camperIds: ['Avi'], cardOnFile: true, stripeCustomerId: 'cus_G', plans: [plan], depositReview: [] };
  db.sql(`INSERT INTO auth.users (id, email) VALUES ('${OWNER}','o@t');
    INSERT INTO camps (id, owner, name) VALUES ('${CAMP}', '${OWNER}', 'T');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('${CAMP}','campistryMe', jsonb_build_object('families', jsonb_build_object('gold', ${lit(fam)})));`);
  for (let n = 1; n <= 3; n++) q(`SELECT flag_plan_collection('${CAMP}','gold','plan_a','deposit_review','old runner night ${n}')::text;`);
  console.log('1. old flag after 3 old-runner nights:', JSON.stringify(row('gold').plans[0].collectionBlocked));
  const r = q(`SELECT flag_plan_collection('${CAMP}','gold','plan_a',NULL,NULL)::text;`);
  console.log('   new runner clears it ->', r);
  console.log('   plan.collectionBlocked now:', JSON.stringify(row('gold').plans[0].collectionBlocked ?? null));

  for (let n = 1; n <= 3; n++) {
    let out; try { out = db.sql(`INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
      VALUES ('${CAMP}', 'autopay_blocked', 'gold:deposit_review:pi_dep', 'Autopay is waiting for an answer',
              'Gold — a card deposit of $250.00 may already have been recorded by hand. Answer the question on this family in Billing; autopay resumes the same night.', 'campistry_me.html');`); } catch (e) { out = 'REFUSED: ' + (String(e.message).match(/duplicate key[^\n]*/) || [String(e.message).slice(0, 120)])[0]; }
    console.log(`2. night ${n} insert:`, String(out).trim().split('\n').pop() || 'ok');
  }
  console.log('   notices the office has:', q(`SELECT string_agg(source_id, ' , ' ORDER BY source_id) FROM notifications WHERE camp_id='${CAMP}' AND source='autopay_blocked';`),
              '| money notice?', q(`SELECT public.is_money_notice('autopay_blocked')::text;`));
} catch (e) { console.log('ERROR', e.message.slice(0, 400)); }
finally { db.stop && db.stop(); }
