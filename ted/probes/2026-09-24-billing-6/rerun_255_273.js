// 6th pass: the owner's paste order — 255..273 in order, twice each — then the
// check script. Also 271 pasted alone again after 273 (does the new one-family
// trigger survive?), and 273 alone.
const R = '/home/user/daily-camp-schedular', fs = require('fs');
const db = require(R + '/tests/e2e/db.js').boot({ port: 5521 });
const file = f => fs.readFileSync(R + '/migrations/' + f, 'utf8');
const verify = fs.readFileSync(R + '/scripts/verify_identity_chain.sql', 'utf8').trim().replace(/;\s*$/, '');
const rows = () => db.sql(`SELECT item || ' => ' || result FROM (${verify}) v WHERE item ~ '^2(5[5-9]|6[0-9]|7[0-3])'`).trim();
const M = fs.readdirSync(R + '/migrations').filter(f => /^(25[5-9]|26[0-9]|27[0-3])_/.test(f)).sort();
const trig = () => db.sql(`SELECT (pg_get_functiondef('public._ledger_started_catch_up()'::regprocedure) ~ '_catch_up_family_ledger')::text;`).trim().split('\n').pop();
try {
  console.log('files:', M.length, M[0], '…', M[M.length - 1]);
  for (let k = 0; k < 2; k++) M.forEach(m => db.sql(file(m)));
  const r = rows();
  console.log('after 255-273 twice each, in order:\n' + r);
  console.log('rows not ok:', r.split('\n').filter(l => !/=> ok$/.test(l)).length);
  console.log('trigger uses one-family catch-up:', trig());
  db.sql(file(M.find(m => m.startsWith('273'))));
  db.sql(file(M.find(m => m.startsWith('271'))));
  console.log('after 273 then 271 again: trigger one-family', trig(), '| not ok rows', rows().split('\n').filter(l => !/=> ok$/.test(l)).length);
} finally { db.stop && db.stop(); }
