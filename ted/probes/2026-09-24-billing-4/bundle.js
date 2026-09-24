// Does the retired APPLY_BUNDLE.sql, run whole on a 262+ database, stop and change nothing?
const R = '/home/user/daily-camp-schedular', fs = require('fs');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5497 });
const h = () => db.sql(`SELECT md5(pg_get_functiondef('public.plan_due(jsonb,jsonb,text)'::regprocedure)) || ' ' || md5(pg_get_functiondef('public.settle_shop_order(uuid,text,text,numeric,boolean)'::regprocedure));`).trim().split('\n').pop();
try {
  const before = h();
  let msg = 'ran to the end';
  try { db.file(R + '/migrations/APPLY_BUNDLE.sql', { singleTransaction: false }); } catch (e) { msg = JSON.stringify(String(e.message).slice(0, 300)) + ' status=' + (e.status ?? ''); }
  console.log('bundle:', msg);
  console.log('plan_due / settle_shop_order unchanged:', before === h());
} finally { db.stop && db.stop(); }
