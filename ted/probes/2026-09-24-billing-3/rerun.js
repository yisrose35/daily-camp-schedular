// Re-run safety of 262-264 and whether the checking script notices each undone.
const R = '/home/user/daily-camp-schedular', fs = require('fs');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5474 });
const file = f => fs.readFileSync(R + '/migrations/' + f, 'utf8');
const verify = fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').trim().replace(/;\s*$/, '');
const rows = () => db.sql(`SELECT item || ' => ' || result FROM (${verify}) v WHERE item ~ '^26[234]'`).trim();
const M = ['262_autopay_waits_for_a_bank_debit.sql', '263_a_cancelled_charge_leaves_the_ledger.sql', '264_a_plan_charges_the_amounts_the_office_set.sql'];
try {
  console.log('fresh chain:\n' + rows());
  for (let k = 0; k < 2; k++) M.forEach(m => { const out = db.sql(file(m)); });
  console.log('after re-running 262, 263, 264 twice each:\n' + rows());
  const d = db.sql(`SELECT count(*) FROM regexp_matches(pg_get_functiondef('public.settle_shop_order(uuid,text,text,numeric,boolean)'::regprocedure), '_sync_charge_to_ledger', 'g')`).trim();
  console.log('times settle_shop_order calls _sync_charge_to_ledger:', d);
  // Undo each and ask the checking script
  db.sql(file('239_a_stranger_cannot_settle_another_camps_order.sql'));
  db.sql(`DO $$ BEGIN EXECUTE (SELECT string_agg(x,'') FROM (SELECT 1) s, LATERAL (SELECT '' x) y); END $$;`);
  const p172 = file('172_autopay_posts_to_ledger.sql');
  const pd = p172.slice(p172.indexOf('CREATE OR REPLACE FUNCTION public.plan_due('), p172.indexOf('$$;', p172.indexOf('CREATE OR REPLACE FUNCTION public.plan_due(')) + 3);
  db.sql(pd);
  db.sql('DROP FUNCTION public.hold_autopay_charge(uuid,text,text,jsonb);');
  console.log('after putting back 239 settle_shop_order, 172 plan_due, and dropping hold_autopay_charge:\n' + rows());
  M.forEach(m => db.sql(file(m)));
  console.log('after applying 262-264 again:\n' + rows());
} finally { db.stop && db.stop(); }
